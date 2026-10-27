/** JSON Schemas for the soundtrack routes — same pattern as assets/schemas.ts. */

import { MOOD_KEYS } from './songCode.js';

export const soundtrackSchema = {
  $id: 'Soundtrack',
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    // Canonical song code, e.g. TOWN-5-8F3A21C0: paste it into the office radio's settings to play the tune.
    code: { type: 'string' },
    mood: { type: 'string', enum: [...MOOD_KEYS] },
    title: { type: ['string', 'null'] },
    author: { $ref: 'PublicAuthor#' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'code', 'mood', 'title', 'author', 'createdAt'],
} as const;

/** Registered alongside `layouts/schemas.ts`'s `sharedSchemas` — assumes `PublicAuthor#` is already registered. */
export const soundtrackSharedSchemas = [soundtrackSchema] as const;

export const listSoundtracksQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 24 },
    cursor: { type: 'string' },
    // A Discord user id (snowflake), same convention as /api/v1/assets?author=.
    author: { type: 'string' },
    mood: { type: 'string', enum: [...MOOD_KEYS] },
  },
} as const;

export const listSoundtracksResponseSchema = {
  200: {
    type: 'object',
    properties: {
      schemaVersion: { type: 'integer' },
      total: { type: 'integer' },
      soundtracks: { type: 'array', items: { $ref: 'Soundtrack#' } },
      nextCursor: { type: ['string', 'null'] },
    },
    required: ['schemaVersion', 'total', 'soundtracks', 'nextCursor'],
  },
} as const;

export const soundtrackParamsSchema = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

export const createSoundtrackBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', maxLength: 40 },
    title: { type: 'string', maxLength: 200 },
  },
  required: ['code'],
} as const;

export const deleteSoundtrackBodySchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 300 },
  },
} as const;
