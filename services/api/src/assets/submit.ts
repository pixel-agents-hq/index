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

import { knownFurnitureIds } from '@pixel-index/layout-core';
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
import { type DecodedCharacterAsset, decodeCharacterZip } from './decodeCharacter.js';
import { type DecodedPetAsset, decodePetZip } from './decodePet.js';
import { existingCustomAssetIds } from './query.js';
import { submitCustomAssetQuerySchema } from './schemas.js';
import { toDetail } from './serialize.js';
import type { IdCollisionChecker } from './zip.js';

type DecodedAsset = DecodedFurnitureAsset | DecodedCharacterAsset | DecodedPetAsset;

/**
 * All three kinds are now fully self-describing zips (#105 follow-up:
 * `assetKind`/`category`/`name` are redundant with what's already inside the
 * zip) — a pet's and a character's manifest are structurally identical
 * (`{id, name}`, no `additionalProperties` restriction on either schema), so
 * manifest shape alone can't tell them apart. The reliable signal is each
 * decoder's own PNG dimension/layout check, so detection IS decoding: try
 * furniture first (its manifest schema is structurally distinct — `category`/
 * `type`/`members` — so a genuine furniture upload with a bad manifest fails
 * clearly here rather than falling through), then character, then pet.
 */
async function decodeAsset(zipBuffer: Buffer, isIdTaken: IdCollisionChecker): Promise<DecodedAsset> {
  const attempts: Array<() => Promise<DecodedAsset>> = [
    () => decodeFurnitureZip(zipBuffer, isIdTaken),
    () => decodeCharacterZip(zipBuffer, isIdTaken),
    () => decodePetZip(zipBuffer, isIdTaken),
  ];

  let lastError: ApiError | undefined;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      lastError = error;
    }
  }

  throw ApiError.validation(
    lastError?.issues ?? [],
    'Could not recognize this zip as a furniture, character, or pet asset — see ' +
      'docs/custom-asset-zip-contract.md for the shape each kind expects.',
  );
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

        const decoded = await decodeAsset(zipBuffer, isIdTaken);

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
                  tags: decoded.tags,
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
