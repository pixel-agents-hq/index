/** Public profiles for accounts which have published at least one layout. */
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { AnyDatabase } from '../db/client.js';
import * as schema from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { RequestSchemas } from '../http.js';
import { authorAvatarSeed } from '../layouts/serialize.js';

export interface AuthorRoutesDeps {
  db: AnyDatabase;
}

const paramsSchema = {
  type: 'object',
  // A Discord user id (snowflake), not the internal Pixel Index UUID (#61) —
  // it isn't formatted as one, so no `format: 'uuid'` here.
  properties: { id: { type: 'string' } },
  required: ['id'],
} as const;

const responseSchema = {
  200: {
    type: 'object',
    properties: {
      schemaVersion: { type: 'integer' },
      author: { $ref: 'PublicAuthor#' },
      publicLayoutCount: { type: 'integer' },
    },
    required: ['schemaVersion', 'author', 'publicLayoutCount'],
  },
} as const;

export function registerAuthorRoutes(app: FastifyInstance, { db }: AuthorRoutesDeps): void {
  // Types for `request.query`/`params`/`body` come from the JSON Schemas already
  // on each route below, instead of being restated as an interface and cast to.
  // `withTypeProvider` is compile-time only — it changes no runtime behaviour and
  // no schema — so the two can no longer drift apart in silence.
  const typed = app.withTypeProvider<RequestSchemas>();

  typed.get(
    '/api/v1/authors/:id',
    { schema: { params: paramsSchema, response: responseSchema } },
    async (request) => {
      const { id } = request.params;
      const [row] = await db
        .select({
          id: schema.users.id,
          discordId: schema.users.discordId,
          username: schema.users.username,
          globalName: schema.users.globalName,
          guildNickname: schema.users.guildNickname,
          avatarUrl: schema.users.avatarUrl,
          avatarSeed: schema.users.avatarSeed,
          publicLayoutCount: sql<number>`count(${schema.layouts.id})::int`,
        })
        .from(schema.users)
        .innerJoin(
          schema.layouts,
          and(
            eq(schema.layouts.authorUserId, schema.users.id),
            eq(schema.layouts.visibility, 'public'),
          ),
        )
        .where(and(eq(schema.users.discordId, id), eq(schema.users.isSystem, false)))
        .groupBy(schema.users.id);

      if (!row || row.publicLayoutCount === 0) throw ApiError.notFound('No public author.');
      return {
        schemaVersion: 1,
        author: {
          discordId: row.discordId,
          username: row.username,
          displayName: row.guildNickname ?? row.globalName ?? row.username,
          avatarUrl: row.avatarUrl,
          avatarSeed: authorAvatarSeed(row),
        },
        publicLayoutCount: row.publicLayoutCount,
      };
    },
  );
}
