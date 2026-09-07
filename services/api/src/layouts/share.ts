/** Authenticated Share trigger: snapshot one layout and enqueue every active subscriber. */
import type { Layout } from '@pixel-index/layout-core';
import { and, count, eq, gte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { requireAuth } from '../auth/context.js';
import { getUserById } from '../auth/users.js';
import type { ApiConfig } from '../config.js';
import type { AnyDatabase } from '../db/client.js';
import { one } from '../db/rows.js';
import * as schema from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { RequestSchemas } from '../http.js';
import { shareRateLimitConfig } from '../rateLimit.js';
import type { WebhookDeliveryWorker } from '../webhooks/delivery.js';
import type { ShareEventDataV1, ShareEventOwner } from '../webhooks/schema.js';
import { authorForLayout, getLayoutBySlug } from './query.js';
import { publicAuthor } from './serialize.js';
import type { UpstreamValidator } from './upstreamValidator.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const shareBodySchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
      },
      required: ['slug'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        layout: { type: 'object', additionalProperties: true },
      },
      required: ['layout'],
    },
  ],
} as const;

export interface ShareAcceptedBody {
  eventId: string;
  occurredAt: string;
  deliveriesQueued: number;
}

export interface ShareRoutesDeps {
  config: ApiConfig;
  db: AnyDatabase;
  upstream: UpstreamValidator | null;
  deliveryWorker: Pick<WebhookDeliveryWorker, 'wake'>;
}

function userOwner(user: schema.User): ShareEventOwner {
  return {
    ...(user.discordId ? { discordId: user.discordId } : {}),
    username: user.username,
    displayName: user.guildNickname ?? user.globalName ?? user.username,
  };
}

export function registerShareRoutes(
  app: FastifyInstance,
  { config, db, upstream, deliveryWorker }: ShareRoutesDeps,
): void {
  const typed = app.withTypeProvider<RequestSchemas>();

  typed.post(
    '/api/v1/layouts/share',
    { ...shareRateLimitConfig(config), schema: { body: shareBodySchema } },
    async (request, reply): Promise<ShareAcceptedBody> => {
      const auth = requireAuth(request);
      const sharer = await getUserById(db, auth.id);
      if (!sharer?.discordId) throw ApiError.unauthorized();

      let data: ShareEventDataV1;
      if ('slug' in request.body) {
        const layout = await getLayoutBySlug(db, request.body.slug);
        if (!layout) throw ApiError.notFound(`No public layout "${request.body.slug}".`);
        const author = await authorForLayout(db, layout.authorUserId);
        const resolvedOwner = publicAuthor(layout, author);
        data = {
          sharerDiscordId: sharer.discordId,
          owner: {
            ...(resolvedOwner.discordId ? { discordId: resolvedOwner.discordId } : {}),
            username: resolvedOwner.username,
            displayName: resolvedOwner.displayName,
          },
          layout: layout.layout as Layout,
          publication: {
            published: true,
            url: `${config.publicApiOrigin}/api/v1/layouts/${encodeURIComponent(layout.slug)}`,
          },
        };
      } else {
        if (!upstream) {
          throw new ApiError(
            503,
            'validator_unavailable',
            'Layout sharing is temporarily unavailable because validation is not configured.',
          );
        }
        const byteLength = Buffer.byteLength(JSON.stringify(request.body.layout), 'utf8');
        if (byteLength > config.maxLayoutBytes) {
          throw new ApiError(
            413,
            'payload_too_large',
            `layout.json must be at most ${config.maxLayoutBytes} bytes (got ${byteLength}).`,
          );
        }
        const validation = upstream.validator.validateLayout(request.body.layout);
        if (!validation.valid) throw ApiError.validation(validation.issues);
        data = {
          sharerDiscordId: sharer.discordId,
          owner: userOwner(sharer),
          layout: request.body.layout as Layout,
          publication: { published: false },
        };
      }

      const occurredAt = new Date();
      const accepted = await db.transaction(async (tx: AnyDatabase) => {
        const [daily] = await tx
          .select({ value: count() })
          .from(schema.shareEvents)
          .where(
            and(
              eq(schema.shareEvents.sharerUserId, sharer.id),
              gte(schema.shareEvents.occurredAt, new Date(occurredAt.getTime() - ONE_DAY_MS)),
            ),
          );
        if ((daily?.value ?? 0) >= config.maxSharesPerUserPerDay) {
          throw new ApiError(
            429,
            'too_many_shares',
            `You have reached the limit of ${config.maxSharesPerUserPerDay} shares per day.`,
          );
        }

        const event = one(
          await tx
            .insert(schema.shareEvents)
            .values({ sharerUserId: sharer.id, data, occurredAt })
            .returning(),
        );
        const subscriptions = await tx
          .select({ id: schema.webhookSubscriptions.id })
          .from(schema.webhookSubscriptions)
          .where(eq(schema.webhookSubscriptions.active, true));
        if (subscriptions.length > 0) {
          await tx.insert(schema.webhookDeliveries).values(
            subscriptions.map((subscription) => ({
              eventId: event.id,
              subscriptionId: subscription.id,
              nextAttemptAt: occurredAt,
            })),
          );
        }
        return { event, deliveriesQueued: subscriptions.length };
      });

      deliveryWorker.wake();
      reply.code(202);
      return {
        eventId: accepted.event.id,
        occurredAt: accepted.event.occurredAt.toISOString(),
        deliveriesQueued: accepted.deliveriesQueued,
      };
    },
  );
}
