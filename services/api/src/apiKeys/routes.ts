/**
 * Moderator-issued API keys (#101) — machine credentials for bot-originated
 * asset uploads. Modeled on `auth/tokens.ts`'s opaque-hash primitive (already
 * used for refresh tokens), not `discordGrant.ts`'s encrypt/decrypt one: a
 * key only ever needs to be *verified*, never redisplayed, so it is hashed
 * at rest and shown to the caller exactly once, at creation.
 */

import type { FastifyInstance } from 'fastify';
import type { FromSchema } from 'json-schema-to-ts';

import { requireCapability } from '../auth/capability.js';
import type { ApiConfig } from '../config.js';
import type { AnyDatabase } from '../db/client.js';
import { ApiError } from '../errors.js';
import { recordModerationAction } from '../moderation/audit.js';
import { issueApiKey, listApiKeys, revokeApiKey } from './issue.js';
import { toApiKeyView } from './serialize.js';

export interface ApiKeyRoutesDeps {
  config: ApiConfig;
  db: AnyDatabase;
}

const issueBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { label: { type: 'string', minLength: 1, maxLength: 100 } },
  required: ['label'],
} as const;

const idParamsSchema = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

export function registerApiKeyRoutes(app: FastifyInstance, { config, db }: ApiKeyRoutesDeps): void {
  app.post<{ Body: FromSchema<typeof issueBodySchema> }>(
    '/api/v1/moderation/api-keys',
    { schema: { body: issueBodySchema } },
    async (request, reply) => {
      const moderator = await requireCapability(db, config, request, 'moderator');
      const { key, value } = await issueApiKey(db, { createdByUserId: moderator.id, label: request.body.label });
      await recordModerationAction(db, {
        actorUserId: moderator.id,
        actorLabel: moderator.username,
        action: 'apikey.create',
        targetType: 'apikey',
        targetId: key.id,
        after: { label: key.label },
      });
      // The only response, ever, that carries the plaintext value.
      reply.code(201);
      return { ...toApiKeyView(key), value };
    },
  );

  app.get('/api/v1/moderation/api-keys', async (request) => {
    await requireCapability(db, config, request, 'moderator');
    const keys = await listApiKeys(db);
    return { schemaVersion: 1, keys: keys.map(toApiKeyView) };
  });

  app.post<{ Params: FromSchema<typeof idParamsSchema> }>(
    '/api/v1/moderation/api-keys/:id/revoke',
    { schema: { params: idParamsSchema } },
    async (request) => {
      const moderator = await requireCapability(db, config, request, 'moderator');
      const revoked = await revokeApiKey(db, request.params.id);
      if (!revoked) throw ApiError.notFound('No API key with that id.');

      await recordModerationAction(db, {
        actorUserId: moderator.id,
        actorLabel: moderator.username,
        action: 'apikey.revoke',
        targetType: 'apikey',
        targetId: revoked.id,
        after: { label: revoked.label },
      });
      return toApiKeyView(revoked);
    },
  );
}
