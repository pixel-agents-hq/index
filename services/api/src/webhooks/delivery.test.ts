import { bundledLayoutRevision, type Layout } from '@pixel-index/layout-core';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.js';
import { createTestDatabase, type Harness } from '../db/test-support/harness.js';
import { testConfig } from '../test-support/config.js';
import { insertUser } from '../test-support/layouts.js';
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  WebhookDeliveryWorker,
} from './delivery.js';
import type { ShareEventDataV1 } from './schema.js';
import { encryptWebhookSecret, webhookSecretHint } from './secret.js';

const config = testConfig();
const logger = Fastify({ logger: false });
const layout: Layout = {
  version: 1,
  layoutRevision: bundledLayoutRevision(),
  cols: 1,
  rows: 1,
  tiles: [0],
  furniture: [],
};
const data: ShareEventDataV1 = {
  sharerDiscordId: '1528094749993599038',
  owner: {
    discordId: '77488778255540224',
    username: 'owner',
    displayName: 'Owner',
  },
  layout,
  publication: { published: false },
};

let harness: Harness;
beforeAll(async () => {
  harness = await createTestDatabase();
});
afterAll(async () => {
  await logger.close();
  await harness.close();
});

async function queuedDelivery(active = true) {
  const user = await insertUser(harness.db);
  const [subscription] = await harness.db
    .insert(schema.webhookSubscriptions)
    .values({
      name: `delivery-${Math.random()}`,
      endpointUrl: 'https://receiver.example/events',
      encryptedSecret: encryptWebhookSecret('whsec_retry-test', config.webhookSecretEncryptionKey),
      secretHint: webhookSecretHint('whsec_retry-test'),
      createdByUserId: user.id,
      createdByDiscordId: user.discordId ?? '1528094749993599038',
      createdByUsername: user.username,
      active,
    })
    .returning();
  const [event] = await harness.db
    .insert(schema.shareEvents)
    .values({ sharerUserId: user.id, data })
    .returning();
  if (!subscription || !event) throw new Error('fixture insert failed');
  const [delivery] = await harness.db
    .insert(schema.webhookDeliveries)
    .values({ eventId: event.id, subscriptionId: subscription.id })
    .returning();
  if (!delivery) throw new Error('fixture insert failed');
  return { subscription, event, delivery };
}

describe('WebhookDeliveryWorker retries', () => {
  it('uses the documented backoff, stops after five attempts, surfaces failure, and does not auto-disable', async () => {
    const fixture = await queuedDelivery();
    let now = new Date('2026-08-15T12:00:00.000Z');
    const fetchImpl = vi.fn(async () => new Response('down', { status: 503 })) as typeof fetch;
    const worker = new WebhookDeliveryWorker(harness.db, config, logger.log, {
      fetchImpl,
      now: () => now,
    });

    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      expect(await worker.drainOnce()).toBe(1);
      const [delivery] = await harness.db
        .select()
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.id, fixture.delivery.id));
      expect(delivery?.attemptCount).toBe(attempt);
      if (attempt < WEBHOOK_MAX_ATTEMPTS) {
        expect(delivery?.status).toBe('retrying');
        expect(delivery?.nextAttemptAt.getTime()).toBe(
          now.getTime() + (WEBHOOK_RETRY_DELAYS_MS[attempt - 1] ?? 0),
        );
        now = delivery?.nextAttemptAt ?? now;
      } else {
        expect(delivery?.status).toBe('failed');
      }
    }

    const [subscription] = await harness.db
      .select()
      .from(schema.webhookSubscriptions)
      .where(eq(schema.webhookSubscriptions.id, fixture.subscription.id));
    expect(subscription).toMatchObject({
      active: true,
      consecutiveFailures: 1,
      lastFailure: 'subscriber returned HTTP 503',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(WEBHOOK_MAX_ATTEMPTS);
    expect(await worker.drainOnce()).toBe(0);
  });

  it('cancels queued work for an inactive subscription without sending it', async () => {
    const fixture = await queuedDelivery(false);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;
    const worker = new WebhookDeliveryWorker(harness.db, config, logger.log, { fetchImpl });
    expect(await worker.drainOnce()).toBe(1);
    const [delivery] = await harness.db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, fixture.delivery.id));
    expect(delivery?.status).toBe('cancelled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
