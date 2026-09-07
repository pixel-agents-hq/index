/** Persistent, signed HTTP delivery for queued share events. */
import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import type { ApiConfig } from '../config.js';
import type { AnyDatabase } from '../db/client.js';
import * as schema from '../db/schema.js';
import { asShareEventData, buildShareEvent } from './event.js';
import { decryptWebhookSecret } from './secret.js';
import {
  signWebhookBody,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from './signature.js';

export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_ATTEMPTS = 5;
export const WEBHOOK_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;
const POLL_INTERVAL_MS = 10_000;
const CLAIM_BATCH_SIZE = 10;
const CLAIM_LEASE_MS = WEBHOOK_DELIVERY_TIMEOUT_MS + 20_000;
const MAX_FAILURE_LENGTH = 500;

interface DeliveryWorkerOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

interface ClaimedDelivery {
  delivery: schema.WebhookDelivery;
  event: schema.ShareEvent;
  subscription: schema.WebhookSubscription;
}

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_FAILURE_LENGTH);
}

/**
 * One worker can be woken immediately after enqueue and also polls so work
 * left by a crashed/restarted replica is recovered. Database leases and
 * `FOR UPDATE SKIP LOCKED` make the poller safe across API replicas.
 */
export class WebhookDeliveryWorker {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private wakeAgain = false;

  constructor(
    private readonly db: AnyDatabase,
    private readonly config: Pick<ApiConfig, 'webhookSecretEncryptionKey'>,
    private readonly log: FastifyBaseLogger,
    options: DeliveryWorkerOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? WEBHOOK_DELIVERY_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), this.pollIntervalMs);
    this.timer.unref();
    this.wake();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Fire-and-report, never a floating rejection from a request handler. */
  wake(): void {
    if (this.running) {
      this.wakeAgain = true;
      return;
    }
    this.running = true;
    void this.drainOnce()
      .catch((error: unknown) => {
        this.log.error({ err: error }, 'webhook delivery worker failed');
      })
      .finally(() => {
        this.running = false;
        if (this.wakeAgain) {
          this.wakeAgain = false;
          this.wake();
        }
      });
  }

  /** Exported behaviour for deterministic integration tests and operations tooling. */
  async drainOnce(): Promise<number> {
    const claimed = await this.claimDue();
    await Promise.all(claimed.map((row) => this.deliver(row)));
    return claimed.length;
  }

  private async claimDue(): Promise<ClaimedDelivery[]> {
    const now = this.now();
    const lockToken = randomUUID();
    const ids = await this.db.transaction(async (tx: AnyDatabase) => {
      const due = await tx
        .select({ id: schema.webhookDeliveries.id })
        .from(schema.webhookDeliveries)
        .where(
          and(
            inArray(schema.webhookDeliveries.status, ['pending', 'retrying']),
            lte(schema.webhookDeliveries.nextAttemptAt, now),
            or(
              isNull(schema.webhookDeliveries.lockedUntil),
              lte(schema.webhookDeliveries.lockedUntil, now),
            ),
          ),
        )
        .orderBy(asc(schema.webhookDeliveries.nextAttemptAt))
        .limit(CLAIM_BATCH_SIZE)
        .for('update', { skipLocked: true });
      const dueIds = due.map((row) => row.id);
      if (dueIds.length === 0) return [];
      await tx
        .update(schema.webhookDeliveries)
        .set({
          lockToken,
          lockedUntil: new Date(now.getTime() + CLAIM_LEASE_MS),
          updatedAt: now,
        })
        .where(inArray(schema.webhookDeliveries.id, dueIds));
      return dueIds;
    });
    if (ids.length === 0) return [];

    return this.db
      .select({
        delivery: schema.webhookDeliveries,
        event: schema.shareEvents,
        subscription: schema.webhookSubscriptions,
      })
      .from(schema.webhookDeliveries)
      .innerJoin(schema.shareEvents, eq(schema.shareEvents.id, schema.webhookDeliveries.eventId))
      .innerJoin(
        schema.webhookSubscriptions,
        eq(schema.webhookSubscriptions.id, schema.webhookDeliveries.subscriptionId),
      )
      .where(
        and(
          inArray(schema.webhookDeliveries.id, ids),
          eq(schema.webhookDeliveries.lockToken, lockToken),
        ),
      );
  }

  private async deliver({ delivery, event, subscription }: ClaimedDelivery): Promise<void> {
    const lockToken = delivery.lockToken;
    if (!lockToken) return;
    if (!subscription.active) {
      await this.db
        .update(schema.webhookDeliveries)
        .set({ status: 'cancelled', lockedUntil: null, lockToken: null, updatedAt: this.now() })
        .where(
          and(
            eq(schema.webhookDeliveries.id, delivery.id),
            eq(schema.webhookDeliveries.lockToken, lockToken),
          ),
        );
      return;
    }

    const attemptedAt = this.now();
    const attemptCount = delivery.attemptCount + 1;
    let statusCode: number | null = null;
    try {
      const secret = decryptWebhookSecret(
        subscription.encryptedSecret,
        this.config.webhookSecretEncryptionKey,
      );
      const body = JSON.stringify(
        buildShareEvent(event.id, event.occurredAt, subscription.id, asShareEventData(event.data)),
      );
      const timestamp = String(Math.floor(attemptedAt.getTime() / 1000));
      const response = await this.fetchImpl(subscription.endpointUrl, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          [WEBHOOK_EVENT_ID_HEADER]: event.id,
          [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
          [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      statusCode = response.status;
      await response.body?.cancel();
      if (!response.ok) throw new Error(`subscriber returned HTTP ${response.status}`);

      await this.db.transaction(async (tx: AnyDatabase) => {
        const finalized = await tx
          .update(schema.webhookDeliveries)
          .set({
            status: 'succeeded',
            attemptCount,
            lastAttemptAt: attemptedAt,
            deliveredAt: attemptedAt,
            lastStatusCode: statusCode,
            lastError: null,
            lockedUntil: null,
            lockToken: null,
            updatedAt: attemptedAt,
          })
          .where(
            and(
              eq(schema.webhookDeliveries.id, delivery.id),
              eq(schema.webhookDeliveries.lockToken, lockToken),
            ),
          )
          .returning({ id: schema.webhookDeliveries.id });
        // A lease can be cleared by deactivation or, if a fetch implementation
        // ignores abort, expire and be reclaimed. Only the current lease owner
        // may mutate subscription health.
        if (finalized.length === 0) return;
        await tx
          .update(schema.webhookSubscriptions)
          .set({
            consecutiveFailures: 0,
            lastAttemptAt: attemptedAt,
            lastSuccessAt: attemptedAt,
            lastFailure: null,
            updatedAt: attemptedAt,
          })
          .where(eq(schema.webhookSubscriptions.id, subscription.id));
      });
      return;
    } catch (error) {
      const message = failureMessage(error);
      const exhausted = attemptCount >= WEBHOOK_MAX_ATTEMPTS;
      const retryDelay = WEBHOOK_RETRY_DELAYS_MS[attemptCount - 1];
      await this.db.transaction(async (tx: AnyDatabase) => {
        const finalized = await tx
          .update(schema.webhookDeliveries)
          .set({
            status: exhausted ? 'failed' : 'retrying',
            attemptCount,
            lastAttemptAt: attemptedAt,
            lastStatusCode: statusCode,
            lastError: message,
            nextAttemptAt:
              exhausted || retryDelay === undefined
                ? attemptedAt
                : new Date(attemptedAt.getTime() + retryDelay),
            lockedUntil: null,
            lockToken: null,
            updatedAt: attemptedAt,
          })
          .where(
            and(
              eq(schema.webhookDeliveries.id, delivery.id),
              eq(schema.webhookDeliveries.lockToken, lockToken),
            ),
          )
          .returning({ id: schema.webhookDeliveries.id });
        if (finalized.length === 0) return;
        await tx
          .update(schema.webhookSubscriptions)
          .set({
            ...(exhausted
              ? {
                  consecutiveFailures: sql`${schema.webhookSubscriptions.consecutiveFailures} + 1`,
                }
              : {}),
            lastAttemptAt: attemptedAt,
            lastFailureAt: attemptedAt,
            lastFailure: message,
            updatedAt: attemptedAt,
          })
          .where(eq(schema.webhookSubscriptions.id, subscription.id));
      });
      this.log.warn(
        { deliveryId: delivery.id, subscriptionId: subscription.id, attemptCount, err: message },
        exhausted ? 'webhook delivery permanently failed' : 'webhook delivery will retry',
      );
    }
  }
}
