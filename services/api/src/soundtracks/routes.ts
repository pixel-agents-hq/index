/**
 * Soundtracks: Pixel Agents office radio tunes, published to showcase them
 * (see `soundtracks` in db/schema.ts for why a song code is all there is to
 * store). The routes follow custom assets': a public newest-first list and
 * detail, a submission-capable publisher, and an owner-or-moderator soft
 * delete recorded in the audit log.
 */

import { and, desc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { assetAuthor } from '../assets/serialize.js';
import { requireSubmissionCapability } from '../auth/capability.js';
import { requireAuth } from '../auth/context.js';
import { getUserById } from '../auth/users.js';
import type { ApiConfig } from '../config.js';
import type { AnyDatabase } from '../db/client.js';
import { one } from '../db/rows.js';
import * as schema from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { RequestSchemas } from '../http.js';
import { type Cursor, decodeCursor, encodeCursor, timestampMicros } from '../layouts/cursor.js';
import { isUniqueViolation } from '../layouts/metadata.js';
import { authorForLayout, authorsForLayouts } from '../layouts/query.js';
import type { PublicAuthor } from '../layouts/serialize.js';
import { recordModerationAction } from '../moderation/audit.js';
import { writeRateLimitConfig } from '../rateLimit.js';
import {
  createSoundtrackBodySchema,
  deleteSoundtrackBodySchema,
  listSoundtracksQuerySchema,
  listSoundtracksResponseSchema,
  soundtrackParamsSchema,
} from './schemas.js';
import { parseSongCode } from './songCode.js';

const SCHEMA_VERSION = 1;
const SORT = 'newest' as const;
const MAX_TITLE_LENGTH = 80;

export interface PublicSoundtrack {
  id: string;
  code: string;
  mood: string;
  title: string | null;
  author: PublicAuthor;
  createdAt: string;
}

function toPublic(row: schema.Soundtrack, author: schema.User | null): PublicSoundtrack {
  return {
    id: row.id,
    code: row.code,
    mood: row.mood,
    title: row.title,
    author: assetAuthor(author),
    createdAt: row.createdAt.toISOString(),
  };
}

async function getLiveSoundtrack(db: AnyDatabase, id: string): Promise<schema.Soundtrack | null> {
  const [row] = await db
    .select()
    .from(schema.soundtracks)
    .where(and(eq(schema.soundtracks.id, id), isNull(schema.soundtracks.deletedAt)));
  return row ?? null;
}

function cursorCondition(cursor: Cursor) {
  return sql`(${timestampMicros(schema.soundtracks.createdAt)}, ${schema.soundtracks.id}) < (${cursor.value}, ${cursor.id})`;
}

/** Same "remains available without guild membership" reasoning as assets/manage.ts's identically named helper. */
async function requireAuthenticatedUser(db: AnyDatabase, request: FastifyRequest): Promise<schema.User> {
  const auth = requireAuth(request);
  const user = await getUserById(db, auth.id);
  if (!user) throw ApiError.unauthorized();
  return user;
}

export interface SoundtrackRoutesDeps {
  config: ApiConfig;
  db: AnyDatabase;
}

export function registerSoundtrackRoutes(app: FastifyInstance, { config, db }: SoundtrackRoutesDeps): void {
  const typed = app.withTypeProvider<RequestSchemas>();

  typed.get(
    '/api/v1/soundtracks',
    { schema: { querystring: listSoundtracksQuerySchema, response: listSoundtracksResponseSchema } },
    async (request) => {
      const query = request.query;
      const conditions: SQL[] = [isNull(schema.soundtracks.deletedAt)];
      if (query.author) {
        const [row] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.discordId, query.author));
        if (!row) return { schemaVersion: SCHEMA_VERSION, total: 0, soundtracks: [], nextCursor: null };
        conditions.push(eq(schema.soundtracks.authorUserId, row.id));
      }
      if (query.mood) conditions.push(eq(schema.soundtracks.mood, query.mood));

      const [totalRow] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.soundtracks)
        .where(and(...conditions));

      const cursor = query.cursor ? decodeCursor(query.cursor, SORT) : null;
      const page = await db
        .select()
        .from(schema.soundtracks)
        .where(cursor ? and(...conditions, cursorCondition(cursor)) : and(...conditions))
        .orderBy(desc(schema.soundtracks.createdAt), desc(schema.soundtracks.id))
        .limit(query.limit + 1);
      const hasMore = page.length > query.limit;
      const rows = hasMore ? page.slice(0, query.limit) : page;

      let nextCursor: string | null = null;
      const lastRow = rows[rows.length - 1];
      if (hasMore && lastRow) {
        // Microseconds, not lastRow.createdAt — see assets/query.ts's listCustomAssets.
        const [micros] = await db
          .select({ value: timestampMicros(schema.soundtracks.createdAt) })
          .from(schema.soundtracks)
          .where(eq(schema.soundtracks.id, lastRow.id));
        nextCursor = encodeCursor({ sort: SORT, value: micros?.value ?? lastRow.createdAt.getTime() * 1000, id: lastRow.id });
      }

      const authors = await authorsForLayouts(db, rows.map((row) => row.authorUserId));
      return {
        schemaVersion: SCHEMA_VERSION,
        total: totalRow?.total ?? 0,
        soundtracks: rows.map((row) => toPublic(row, authors.get(row.authorUserId) ?? null)),
        nextCursor,
      };
    },
  );

  typed.get('/api/v1/soundtracks/:id', { schema: { params: soundtrackParamsSchema } }, async (request) => {
    const row = await getLiveSoundtrack(db, request.params.id);
    if (!row) throw ApiError.notFound('No such soundtrack.');
    return toPublic(row, await authorForLayout(db, row.authorUserId));
  });

  typed.post(
    '/api/v1/soundtracks',
    { ...writeRateLimitConfig(config), schema: { body: createSoundtrackBodySchema } },
    async (request, reply) => {
      const user = await requireSubmissionCapability(db, config, request);
      const parsed = parseSongCode(request.body.code);
      if (!parsed) {
        throw ApiError.validation(
          [{ code: 'meta.schema', path: '/code', message: 'Not a song code the office radio can play (e.g. TOWN-5-8F3A21C0).' }],
          'Invalid soundtrack.',
        );
      }
      const title = request.body.title?.trim() || null;
      if (title && title.length > MAX_TITLE_LENGTH) {
        throw ApiError.badRequest(`title must be at most ${MAX_TITLE_LENGTH} characters.`);
      }

      let created: schema.Soundtrack;
      try {
        created = await db.transaction(async (tx: AnyDatabase) => {
          const row = one(
            await tx
              .insert(schema.soundtracks)
              .values({ code: parsed.code, mood: parsed.mood, title, authorUserId: user.id })
              .returning(),
          );
          await recordModerationAction(tx, {
            actorUserId: user.id,
            actorLabel: user.username,
            action: 'soundtrack.create',
            targetType: 'soundtrack',
            targetId: row.id,
            after: { code: row.code, title: row.title },
          });
          return row;
        });
      } catch (error) {
        if (isUniqueViolation(error, 'soundtracks_author_code_key')) {
          throw ApiError.conflict(`You have already published ${parsed.code}.`);
        }
        throw error;
      }

      reply.code(201).header('location', `/api/v1/soundtracks/${created.id}`);
      return toPublic(created, user);
    },
  );

  typed.delete(
    '/api/v1/soundtracks/:id',
    { schema: { params: soundtrackParamsSchema, body: deleteSoundtrackBodySchema } },
    async (request, reply) => {
      const user = await requireAuthenticatedUser(db, request);
      // Any state, so a repeat delete is the idempotent no-op it is (assets/manage.ts).
      const [row] = await db.select().from(schema.soundtracks).where(eq(schema.soundtracks.id, request.params.id));
      if (!row) throw ApiError.notFound('No such soundtrack.');

      const isOwner = row.authorUserId === user.id;
      const isModerator = user.role === 'moderator' || user.role === 'admin';
      if (!isOwner && !isModerator) throw ApiError.forbidden();
      if (row.deletedAt !== null) return reply.code(204).send();

      // Someone else's is moderation and needs a reason — "no silent moderation" (#10).
      const reason = request.body?.reason;
      if (!isOwner && !reason) throw ApiError.badRequest('A reason is required for this change.');

      const deletedAt = new Date();
      await db.transaction(async (tx: AnyDatabase) => {
        await tx.update(schema.soundtracks).set({ deletedAt }).where(eq(schema.soundtracks.id, row.id));
        await recordModerationAction(tx, {
          actorUserId: user.id,
          actorLabel: user.username,
          action: 'soundtrack.delete',
          targetType: 'soundtrack',
          targetId: row.id,
          reason: isOwner ? null : (reason ?? null),
          before: { deletedAt: null },
          after: { deletedAt: deletedAt.toISOString() },
        });
      });
      return reply.code(204).send();
    },
  );
}
