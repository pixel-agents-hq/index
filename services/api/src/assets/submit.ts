/**
 * POST /api/v1/assets — publish a custom furniture asset (#101).
 *
 * Same ordering discipline as `layouts/submit.ts`: auth first, then cheap
 * checks, then the expensive unzip/decode, then persist. No moderator
 * pre-publish review (#101's decision) — a valid upload is live the moment
 * this returns 201.
 *
 * Stage 1 of #101: web-auth only (`requireSubmissionCapability`, the same
 * Basic/guild-membership gate layout submission already uses — any guild
 * member may upload). The bot-authenticated (`X-Api-Key`) path is a
 * follow-up stage.
 */

import { knownFurnitureIds } from '@pixel-index/layout-core';
import type { FastifyInstance } from 'fastify';
import type { FromSchema } from 'json-schema-to-ts';

import { requireSubmissionCapability } from '../auth/capability.js';
import type { ApiConfig } from '../config.js';
import type { AnyDatabase } from '../db/client.js';
import { one } from '../db/rows.js';
import * as schema from '../db/schema.js';
import { ApiError } from '../errors.js';
import { isUniqueViolation } from '../layouts/metadata.js';
import { recordModerationAction } from '../moderation/audit.js';
import { writeRateLimitConfig } from '../rateLimit.js';
import { decodeAssetZip } from './decode.js';
import { existingCustomAssetIds } from './query.js';
import { submitCustomAssetQuerySchema } from './schemas.js';
import { toDetail } from './serialize.js';

export interface AssetSubmitRoutesDeps {
  config: ApiConfig;
  db: AnyDatabase;
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
        const user = await requireSubmissionCapability(db, config, request);

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

        const decoded = await decodeAssetZip(zipBuffer, request.query.name, request.query.category, isIdTaken);

        let created: schema.CustomAsset;
        try {
          created = await db.transaction(async (tx: AnyDatabase) => {
            const row = one(
              await tx
                .insert(schema.customAssets)
                .values({
                  assetId: decoded.assetId,
                  requestedAssetId: decoded.requestedAssetId,
                  name: decoded.name,
                  category: decoded.category,
                  manifest: decoded.manifest,
                  sprites: decoded.sprites,
                  rawZip: zipBuffer,
                  authorUserId: user.id,
                })
                .returning(),
            );
            await recordModerationAction(tx, {
              actorUserId: user.id,
              actorLabel: user.username,
              action: 'asset.create',
              targetType: 'asset',
              targetId: row.id,
              after: { assetId: row.assetId, name: row.name, category: row.category },
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
