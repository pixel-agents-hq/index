/**
 * `GET /api/v1/avatars/:seed.png` (#133): the avatar `@pixel-index/pixatar`
 * draws for a seed code. Public, like every read here, with its own rate-limit
 * bucket because a cache miss is a render (see render.ts for the seed policy
 * and the caps).
 */

import type { FastifyInstance } from 'fastify';

import type { ApiConfig } from '../config.js';
import type { RequestSchemas } from '../http.js';
import { respondNotModifiedIfMatching } from '../layouts/caching.js';
import {
  AVATAR_BACKGROUNDS,
  AVATAR_CACHE_CONTROL,
  AVATAR_VENDOR_COMMIT,
  DEFAULT_AVATAR_SCALE,
  MAX_AVATAR_SCALE,
  MAX_SEED_CODE_LENGTH,
  renderAvatarPng,
} from './render.js';

export interface AvatarRoutesDeps {
  config: ApiConfig;
}

const paramsSchema = {
  type: 'object',
  properties: {
    // Checked in the handler rather than with `pattern`/`maxLength` here, so a
    // bad seed gets its own `invalid_seed` error, saying what a seed code is,
    // instead of ajv's generic message.
    seed: {
      type: 'string',
      description: `A seed code: px. followed by base64url, at most ${MAX_SEED_CODE_LENGTH} characters. Free text is refused.`,
    },
  },
  required: ['seed'],
} as const;

const querySchema = {
  type: 'object',
  properties: {
    scale: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_AVATAR_SCALE,
      default: DEFAULT_AVATAR_SCALE,
      description: 'The avatar is 20×20 pixels times this.',
    },
    background: {
      type: 'string',
      enum: AVATAR_BACKGROUNDS,
      description: "The seed code's background colour, or none. Omitted: as the seed code says.",
    },
  },
  additionalProperties: false,
} as const;

export function registerAvatarRoutes(app: FastifyInstance, { config }: AvatarRoutesDeps): void {
  const typed = app.withTypeProvider<RequestSchemas>();

  typed.get(
    '/api/v1/avatars/:seed.png',
    {
      schema: {
        description:
          'The Pixel Agents character avatar a seed code stands for, as a PNG. ' +
          'Deterministic: the same code, scale and background give the same bytes for a given pinned Pixel Agents.',
        params: paramsSchema,
        querystring: querySchema,
      },
      config: {
        rateLimit: {
          max: config.avatarRateLimit.max,
          timeWindow: config.avatarRateLimit.windowMs,
        },
      },
    },
    (request, reply) => {
      const { seed } = request.params;
      const { scale, background } = request.query;
      const avatar = renderAvatarPng(seed, {
        // ajv's `useDefaults` (server.ts AJV_OPTIONS) fills it in.
        scale: scale ?? DEFAULT_AVATAR_SCALE,
        ...(background ? { background } : {}),
      });

      reply
        .header('cache-control', AVATAR_CACHE_CONTROL)
        .header('x-content-type-options', 'nosniff')
        .header('x-pixatar-vendor', AVATAR_VENDOR_COMMIT);
      if (respondNotModifiedIfMatching(request, reply, avatar.etag)) return reply;
      return reply.header('content-type', 'image/png').send(avatar.png);
    },
  );
}
