/**
 * Deleting a custom asset (#125) — owner or moderator. The access-control
 * shape mirrors layouts/manage.ts's DELETE `/api/v1/layouts/:slug` (#72)
 * closely on purpose: `isOwner`/`isModerator` may act, a moderator deleting
 * someone ELSE's asset must supply a `reason` ("no silent moderation", #10's
 * rule), and an owner deleting their own needs none. This is a brand new,
 * independent endpoint living entirely under assets/, not a change to
 * layouts' own DELETE route.
 *
 * Soft delete, not `DELETE FROM`: `assetId` is embedded in every public URL
 * (`/api/v1/assets/:assetId`, `/download`, `/sprite.png`, `/frames`, catalog
 * merges), so it has to stay permanently reserved once issued — the same
 * reasoning layouts' `deleted` visibility already established for slugs (a
 * superseded slug is evicted, never freed, so an old link can never resolve
 * to different content later). `customAssets.deletedAt` (db/schema.ts) is
 * the whole mechanism: null is live, set is gone, and every public read
 * route filters it out (`query.ts`'s `getPublicCustomAssetByAssetId` and
 * friends). No separate `visibility` enum copied from layouts — there is no
 * public/hidden distinction to make here, just deleted-or-not, so a nullable
 * timestamp is the entire model. A full hard delete was the alternative:
 * simpler, and assets don't have a pre-existing moderation/audit-trail
 * requirement the way layouts did going in — but it would silently free
 * `assetId` for a later, unrelated upload to claim, which is the one thing
 * this decision has to avoid.
 *
 * Built-in assets (`source: 'builtin'`) can never be deleted through this or
 * any route — they're synced from the read-only `vendor/pixel-agents` pin by
 * `builtinSync.ts`, not user content. Rejected with 403, not 404:
 * `GET /:assetId` already serves a builtin row plainly, so pretending one
 * doesn't exist here would be inconsistent with every other route that can
 * see it just fine.
 */

import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { requireAuth } from '../auth/context.js';
import { getUserById } from '../auth/users.js';
import type { AnyDatabase } from '../db/client.js';
import * as schema from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { RequestSchemas } from '../http.js';
import { recordModerationAction } from '../moderation/audit.js';
import { getCustomAssetByAssetId } from './query.js';
import { assetIdParamsSchema } from './schemas.js';

export interface AssetManageRoutesDeps {
  db: AnyDatabase;
}

const MAX_REASON_LENGTH = 300;

/**
 * Same hand-rolled validation as layouts/manage.ts's `readOptionalReason`,
 * duplicated rather than imported — this file stays self-contained under
 * assets/ instead of reaching into layouts/ for ten lines. DELETE has no
 * `body` JSON Schema: an owner's historically bodiless request has to keep
 * working, and AJV has no clean way to say "validate this shape IF a body is
 * present, but do not require one to exist".
 */
function readOptionalReason(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw ApiError.badRequest('Body must be a JSON object.');
  }
  const reason = (body as Record<string, unknown>).reason;
  if (reason === undefined) return undefined;
  if (typeof reason !== 'string' || reason.length < 1 || reason.length > MAX_REASON_LENGTH) {
    throw ApiError.badRequest(`reason must be a string between 1 and ${MAX_REASON_LENGTH} characters.`);
  }
  return reason;
}

/** Deleting one's own upload remains available after leaving the guild or when Discord needs reconnecting — same reasoning as layouts/manage.ts's identically named helper. */
async function requireAuthenticatedUser(db: AnyDatabase, request: FastifyRequest): Promise<schema.User> {
  const auth = requireAuth(request);
  const user = await getUserById(db, auth.id);
  if (!user) throw ApiError.unauthorized();
  return user;
}

export function registerAssetManageRoutes(app: FastifyInstance, { db }: AssetManageRoutesDeps): void {
  const typed = app.withTypeProvider<RequestSchemas>();

  typed.delete(
    '/api/v1/assets/:assetId',
    { schema: { params: assetIdParamsSchema } },
    async (request, reply) => {
      const user = await requireAuthenticatedUser(db, request);
      const { assetId } = request.params;

      // Any state, including already-deleted — an idempotent repeat delete
      // (below) needs to find the row too, same as layouts' DELETE.
      const asset = await getCustomAssetByAssetId(db, assetId);
      if (!asset) throw ApiError.notFound(`No custom asset "${assetId}".`);

      if (asset.source === 'builtin') {
        throw ApiError.forbidden('Built-in assets cannot be deleted.');
      }

      const isOwner = asset.authorUserId === user.id;
      const isModerator = user.role === 'moderator' || user.role === 'admin';
      if (!isOwner && !isModerator) throw ApiError.forbidden();

      if (asset.deletedAt !== null) return reply.code(204).send();

      // Deleting someone ELSE's asset is moderation and needs a reason —
      // "no silent moderation" (#10), same rule layouts' DELETE applies.
      // Deleting your own needs none, moderator or not.
      const actingAsModerator = !isOwner;
      const reason = readOptionalReason(request.body);
      if (actingAsModerator && !reason) {
        throw ApiError.badRequest('A reason is required for this change.');
      }

      const deletedAt = new Date();
      await db.transaction(async (tx: AnyDatabase) => {
        await tx.update(schema.customAssets).set({ deletedAt }).where(eq(schema.customAssets.id, asset.id));
        await recordModerationAction(tx, {
          actorUserId: user.id,
          actorLabel: user.username,
          action: 'asset.delete',
          targetType: 'asset',
          targetId: asset.id,
          reason: actingAsModerator ? (reason ?? null) : null,
          before: { deletedAt: null },
          after: { deletedAt: deletedAt.toISOString() },
        });
      });

      return reply.code(204).send();
    },
  );
}
