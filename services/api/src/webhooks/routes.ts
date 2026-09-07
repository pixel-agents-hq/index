/** Moderator-issued webhook subscriptions and the Admin delivery-health view. */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { requireCapability } from '../auth/capability.js';
import type { ApiConfig } from '../config.js';
import type { AnyDatabase } from '../db/client.js';
import { one } from '../db/rows.js';
import * as schema from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { RequestSchemas } from '../http.js';
import { isUniqueViolation } from '../layouts/metadata.js';
import {
  encryptWebhookSecret,
  generateWebhookSecret,
  webhookSecretHint,
} from './secret.js';

export interface WebhookSubscriptionView {
  id: string;
  name: string;
  endpointUrl: string;
  secretHint: string;
  active: boolean;
  createdBy: { discordId: string; username: string };
  createdAt: string;
  updatedAt: string;
  secretRotatedAt: string | null;
  consecutiveFailures: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailure: string | null;
}

export interface ListWebhookSubscriptionsBody {
  subscriptions: WebhookSubscriptionView[];
}

export interface CreatedWebhookSubscriptionBody {
  subscription: WebhookSubscriptionView;
  /** Returned exactly once. It is never present in a later list response. */
  secret: string;
}

const createBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    endpointUrl: { type: 'string', format: 'uri', maxLength: 2048 },
  },
  required: ['name', 'endpointUrl'],
} as const;

const subscriptionParamsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

const patchBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { active: { type: 'boolean' } },
  required: ['active'],
} as const;

function endpointUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw ApiError.badRequest('endpointUrl must be a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:') {
    throw ApiError.badRequest('endpointUrl must use HTTPS.');
  }
  if (url.username || url.password || url.hash) {
    throw ApiError.badRequest('endpointUrl must not contain credentials or a fragment.');
  }
  return url.toString();
}

function toView(row: schema.WebhookSubscription): WebhookSubscriptionView {
  return {
    id: row.id,
    name: row.name,
    endpointUrl: row.endpointUrl,
    secretHint: row.secretHint,
    active: row.active,
    createdBy: { discordId: row.createdByDiscordId, username: row.createdByUsername },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    secretRotatedAt: row.secretRotatedAt?.toISOString() ?? null,
    consecutiveFailures: row.consecutiveFailures,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    lastFailure: row.lastFailure,
  };
}

export interface WebhookSubscriptionRoutesDeps {
  config: ApiConfig;
  db: AnyDatabase;
}

export function registerWebhookSubscriptionRoutes(
  app: FastifyInstance,
  { config, db }: WebhookSubscriptionRoutesDeps,
): void {
  const typed = app.withTypeProvider<RequestSchemas>();

  typed.get('/api/v1/moderation/webhook-subscriptions', async (request): Promise<ListWebhookSubscriptionsBody> => {
    const user = await requireCapability(db, config, request, 'moderator');
    const rows = await db
      .select()
      .from(schema.webhookSubscriptions)
      .where(user.role === 'admin' ? undefined : eq(schema.webhookSubscriptions.createdByUserId, user.id))
      .orderBy(desc(schema.webhookSubscriptions.createdAt));
    return { subscriptions: rows.map(toView) };
  });

  typed.post(
    '/api/v1/moderation/webhook-subscriptions',
    { schema: { body: createBodySchema } },
    async (request, reply): Promise<CreatedWebhookSubscriptionBody> => {
      const user = await requireCapability(db, config, request, 'moderator');
      if (!user.discordId) throw ApiError.forbidden('A Discord-backed moderator account is required.');
      const name = request.body.name.trim();
      if (name === '') throw ApiError.badRequest('name must not be blank.');
      const secret = generateWebhookSecret();
      const now = new Date();
      let created: schema.WebhookSubscription;
      try {
        created = one(
          await db
            .insert(schema.webhookSubscriptions)
            .values({
              name,
              endpointUrl: endpointUrl(request.body.endpointUrl),
              encryptedSecret: encryptWebhookSecret(secret, config.webhookSecretEncryptionKey),
              secretHint: webhookSecretHint(secret),
              createdByUserId: user.id,
              createdByDiscordId: user.discordId,
              createdByUsername: user.username,
              createdAt: now,
              updatedAt: now,
            })
            .returning(),
        );
      } catch (error) {
        if (isUniqueViolation(error, 'webhook_subscriptions_name_key')) {
          throw ApiError.conflict('A webhook subscription with that service name already exists.');
        }
        throw error;
      }
      reply.code(201).header('location', `/api/v1/moderation/webhook-subscriptions/${created.id}`);
      return { subscription: toView(created), secret };
    },
  );

  typed.post(
    '/api/v1/moderation/webhook-subscriptions/:id/rotate',
    { schema: { params: subscriptionParamsSchema } },
    async (request): Promise<CreatedWebhookSubscriptionBody> => {
      const user = await requireCapability(db, config, request, 'moderator');
      const [existing] = await db
        .select()
        .from(schema.webhookSubscriptions)
        .where(eq(schema.webhookSubscriptions.id, request.params.id));
      if (!existing) throw ApiError.notFound('No webhook subscription with that id.');
      if (user.role !== 'admin' && existing.createdByUserId !== user.id) {
        throw ApiError.forbidden('Only the creator or an admin may rotate this secret.');
      }
      const secret = generateWebhookSecret();
      const now = new Date();
      const updated = one(
        await db
          .update(schema.webhookSubscriptions)
          .set({
            encryptedSecret: encryptWebhookSecret(secret, config.webhookSecretEncryptionKey),
            secretHint: webhookSecretHint(secret),
            secretRotatedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.webhookSubscriptions.id, existing.id))
          .returning(),
      );
      return { subscription: toView(updated), secret };
    },
  );

  typed.patch(
    '/api/v1/admin/webhook-subscriptions/:id',
    { schema: { params: subscriptionParamsSchema, body: patchBodySchema } },
    async (request): Promise<WebhookSubscriptionView> => {
      await requireCapability(db, config, request, 'admin');
      const now = new Date();
      const [updated] = await db
        .update(schema.webhookSubscriptions)
        .set({ active: request.body.active, updatedAt: now })
        .where(eq(schema.webhookSubscriptions.id, request.params.id))
        .returning();
      if (!updated) throw ApiError.notFound('No webhook subscription with that id.');
      if (!updated.active) {
        await db
          .update(schema.webhookDeliveries)
          .set({ status: 'cancelled', lockedUntil: null, lockToken: null, updatedAt: now })
          .where(
            and(
              eq(schema.webhookDeliveries.subscriptionId, updated.id),
              inArray(schema.webhookDeliveries.status, ['pending', 'retrying']),
            ),
          );
      }
      return toView(updated);
    },
  );
}
