/**
 * POST /api/v1/assets — publish a custom furniture asset (#101).
 *
 * Same ordering discipline as `layouts/submit.ts`: auth first, then cheap
 * checks, then the expensive unzip/decode, then persist. No moderator
 * pre-publish review (#101's decision) — a valid upload is live the moment
 * this returns 201.
 *
 * Two independent ways in, same as `backup/export.ts`'s two-credential
 * route: an `Authorization: Bearer` session (a human, via the web app —
 * `requireSubmissionCapability`, the same Basic/guild-membership gate layout
 * submission already uses) or `X-Api-Key` (a bot, e.g. `animator` — #101's
 * moderator-issued machine credential, `apiKeys/verify.ts`). The two are
 * mutually exclusive per request, and an API-key upload MUST also carry
 * `discordUserId` in the query: the key authenticates the calling *service*,
 * not a specific person, so attribution travels as data instead. Pixel Index
 * cannot independently re-verify that id is a real guild member the way it
 * can for a human's own OAuth session — the trust boundary for this path is
 * custody of the key itself, not a per-call check (see #101's discussion).
 */

import { furnitureCategories, knownFurnitureIds } from '@pixel-index/layout-core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FromSchema } from 'json-schema-to-ts';

import { verifyApiKey } from '../apiKeys/issue.js';
import { presentedApiKey } from '../apiKeys/verify.js';
import { requireSubmissionCapability } from '../auth/capability.js';
import { resolveOrCreateGhostUser } from '../auth/users.js';
import type { ApiConfig } from '../config.js';
import type { AnyDatabase } from '../db/client.js';
import { one } from '../db/rows.js';
import * as schema from '../db/schema.js';
import { ApiError } from '../errors.js';
import { isUniqueViolation } from '../layouts/metadata.js';
import { recordModerationAction } from '../moderation/audit.js';
import { writeRateLimitConfig } from '../rateLimit.js';
import { type DecodedFurnitureAsset, decodeFurnitureZip } from './decode.js';
import type { DecodedCharacterAsset } from './decodeCharacter.js';
import { decodeCharacterZip } from './decodeCharacter.js';
import { type DecodedPetAsset, decodePetZip } from './decodePet.js';
import { existingCustomAssetIds } from './query.js';
import { buildSubmitCustomAssetQuerySchema } from './schemas.js';
import { toDetail } from './serialize.js';
import type { IdCollisionChecker } from './zip.js';

type DecodedAsset = DecodedFurnitureAsset | DecodedCharacterAsset | DecodedPetAsset;

/**
 * Dispatches on `assetKind` to the one decode module that knows that kind's
 * zip shape (#105) — everything below this call (insert, moderation audit,
 * response) is kind-agnostic and stays that way, which is what makes the
 * upload gating above it structurally uniform rather than three call sites
 * that happen to agree today.
 */
async function decodeByKind(
  assetKind: 'furniture' | 'character' | 'pet',
  zipBuffer: Buffer,
  name: string,
  category: string | undefined,
  isIdTaken: IdCollisionChecker,
): Promise<DecodedAsset> {
  switch (assetKind) {
    case 'furniture': {
      if (!category) throw ApiError.badRequest('category is required when assetKind is "furniture".');
      return decodeFurnitureZip(zipBuffer, name, category, isIdTaken);
    }
    case 'character': {
      if (category) throw ApiError.badRequest('category is only accepted when assetKind is "furniture".');
      return decodeCharacterZip(zipBuffer, name, isIdTaken);
    }
    case 'pet': {
      if (category) throw ApiError.badRequest('category is only accepted when assetKind is "furniture".');
      return decodePetZip(zipBuffer, name, isIdTaken);
    }
  }
}

export interface AssetSubmitRoutesDeps {
  config: ApiConfig;
  db: AnyDatabase;
}

interface Uploader {
  user: schema.User;
  actorLabel: string;
}

/** Resolves which of the two credentials authorized this request, and who the upload attributes to. */
async function resolveUploader(
  db: AnyDatabase,
  config: ApiConfig,
  request: FastifyRequest,
  discordUserId: string | undefined,
): Promise<Uploader> {
  const presented = presentedApiKey(request);
  if (presented !== undefined) {
    const apiKey = await verifyApiKey(db, presented);
    if (!apiKey) throw ApiError.unauthorized('Invalid or revoked API key.');
    if (!discordUserId) {
      throw ApiError.badRequest('discordUserId is required for an X-Api-Key-authenticated upload.');
    }
    const user = await resolveOrCreateGhostUser(db, discordUserId);
    return { user, actorLabel: `${user.username} (via API key "${apiKey.label}")` };
  }

  if (discordUserId) {
    throw ApiError.badRequest('discordUserId is only accepted with an X-Api-Key-authenticated upload.');
  }
  const user = await requireSubmissionCapability(db, config, request);
  return { user, actorLabel: user.username };
}

export function registerAssetSubmitRoutes(app: FastifyInstance, { config, db }: AssetSubmitRoutesDeps): void {
  // Built once per app instance, not per request — config.upstreamDir isn't
  // known at module load time, but the category set itself is static for
  // the process's lifetime.
  //
  // Same degrade-rather-than-crash contract as /api/v1/meta's own
  // upstreamPin() read (meta.ts): an unreadable/missing upstream must not
  // take down route registration for the whole app. An empty category list
  // falls back to an unconstrained string (buildSubmitCustomAssetQuerySchema
  // below) rather than an empty enum, which ajv rejects outright as an
  // invalid schema.
  let categories: string[];
  try {
    categories = furnitureCategories(config.upstreamDir);
  } catch (error) {
    app.log.warn({ err: error }, 'could not read the pinned upstream for the furniture category enum');
    categories = [];
  }
  const submitCustomAssetQuerySchema = buildSubmitCustomAssetQuerySchema(categories);

  // eslint-disable-next-line @typescript-eslint/require-await
  app.register(async (instance) => {
    // Scoped to this route only, same reasoning as layouts/submit.ts's
    // `application/json` override: the upload is a zip, not JSON, so this
    // just needs the raw bytes rather than any parsed shape.
    instance.addContentTypeParser('application/zip', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });

    instance.post<{ Body: Buffer; Querystring: FromSchema<typeof submitCustomAssetQuerySchema> }>(
      '/api/v1/assets',
      { ...writeRateLimitConfig(config), schema: { querystring: submitCustomAssetQuerySchema } },
      async (request, reply) => {
        const { user, actorLabel } = await resolveUploader(db, config, request, request.query.discordUserId);

        const zipBuffer = request.body;
        if (zipBuffer.byteLength > config.maxAssetZipBytes) {
          throw new ApiError(
            413,
            'payload_too_large',
            `Upload must be at most ${config.maxAssetZipBytes} bytes (got ${zipBuffer.byteLength}).`,
          );
        }

        const builtIn = knownFurnitureIds(config.upstreamDir);
        const existing = await existingCustomAssetIds(db);
        const isIdTaken = (id: string) => builtIn.has(id) || existing.has(id);

        const decoded = await decodeByKind(
          request.query.assetKind,
          zipBuffer,
          request.query.name,
          request.query.category,
          isIdTaken,
        );

        let created: schema.CustomAsset;
        try {
          created = await db.transaction(async (tx: AnyDatabase) => {
            const row = one(
              await tx
                .insert(schema.customAssets)
                .values({
                  assetKind: decoded.assetKind,
                  assetId: decoded.assetId,
                  requestedAssetId: decoded.requestedAssetId,
                  name: decoded.name,
                  category: decoded.category,
                  manifest: decoded.manifest,
                  sprites: decoded.sprites,
                  rawZip: zipBuffer,
                  authorUserId: user.id,
                  source: 'custom',
                })
                .returning(),
            );
            await recordModerationAction(tx, {
              actorUserId: user.id,
              actorLabel,
              action: 'asset.create',
              targetType: 'asset',
              targetId: row.id,
              after: { assetId: row.assetId, assetKind: row.assetKind, name: row.name, category: row.category },
            });
            return row;
          });
        } catch (error) {
          // A genuine race: two uploads picked the same free id between this
          // request's collision check and its insert. Rare enough not to
          // retry — asking the client to resubmit re-runs the collision
          // check fresh, same as a slug retry would.
          if (isUniqueViolation(error, 'custom_assets_asset_id_key')) {
            throw ApiError.conflict('That asset id was just taken by another upload. Please retry.');
          }
          throw error;
        }

        reply.code(201).header('location', `/api/v1/assets/${created.assetId}`);
        return toDetail(created, user);
      },
    );
  });
}
