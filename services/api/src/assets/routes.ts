/**
 * The public custom-asset API (#101) — reading is public, mirroring
 * `layouts/routes.ts`. No auth anywhere in this file.
 */

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { AnyDatabase } from '../db/client.js';
import * as schema from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { RequestSchemas } from '../http.js';
import { authorForLayout, authorsForLayouts } from '../layouts/query.js';
import type { FlattenedAsset } from './manifest.js';
import { allCustomAssetCatalog, listCustomAssets } from './query.js';
import {
  assetIdParamsSchema,
  customAssetCatalogResponseSchema,
  customAssetDetailResponseSchema,
  listCustomAssetsQuerySchema,
  listCustomAssetsResponseSchema,
} from './schemas.js';
import { toDetail, toSummary } from './serialize.js';
import { encodeSpritePng } from './spritePng.js';

export interface AssetRoutesDeps {
  db: AnyDatabase;
}

const SCHEMA_VERSION = 1;

/** The manifest variant a gallery thumbnail should show — front orientation, or the only one there is. */
function representativeVariant(manifest: FlattenedAsset[]): FlattenedAsset | undefined {
  return manifest.find((entry) => !entry.orientation || entry.orientation === 'front') ?? manifest[0];
}

export function registerAssetRoutes(app: FastifyInstance, { db }: AssetRoutesDeps): void {
  const typed = app.withTypeProvider<RequestSchemas>();

  typed.get(
    '/api/v1/assets',
    { schema: { querystring: listCustomAssetsQuerySchema, response: listCustomAssetsResponseSchema } },
    async (request) => {
      const query = request.query;
      let author: string | undefined;
      if (query.author) {
        const [row] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.discordId, query.author));
        if (!row) return { schemaVersion: SCHEMA_VERSION, total: 0, assets: [], nextCursor: null };
        author = row.id;
      }

      const { rows, total, nextCursor } = await listCustomAssets(db, {
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        filters: {
          ...(query.category ? { category: query.category } : {}),
          ...(author ? { author } : {}),
        },
      });

      const authors = await authorsForLayouts(db, rows.map((row) => row.authorUserId));
      return {
        schemaVersion: SCHEMA_VERSION,
        total,
        assets: rows.map((row) => toSummary(row, authors.get(row.authorUserId) ?? null)),
        nextCursor,
      };
    },
  );

  typed.get(
    '/api/v1/assets/catalog',
    { schema: { response: customAssetCatalogResponseSchema } },
    async () => {
      const { catalog, sprites } = await allCustomAssetCatalog(db);
      return { schemaVersion: SCHEMA_VERSION, catalog, sprites };
    },
  );

  typed.get(
    '/api/v1/assets/:assetId',
    { schema: { params: assetIdParamsSchema, response: customAssetDetailResponseSchema } },
    async (request) => {
      const { assetId } = request.params;
      const [asset] = await db.select().from(schema.customAssets).where(eq(schema.customAssets.assetId, assetId));
      if (!asset) throw ApiError.notFound(`No custom asset "${assetId}".`);

      const author = await authorForLayout(db, asset.authorUserId);
      return toDetail(asset, author);
    },
  );

  typed.get(
    '/api/v1/assets/:assetId/sprite.png',
    { schema: { params: assetIdParamsSchema } },
    async (request, reply) => {
      const { assetId } = request.params;
      const [asset] = await db.select().from(schema.customAssets).where(eq(schema.customAssets.assetId, assetId));
      if (!asset) throw ApiError.notFound(`No custom asset "${assetId}".`);

      const manifest = asset.manifest as FlattenedAsset[];
      const variant = representativeVariant(manifest);
      const sprites = asset.sprites as Record<string, string[][]>;
      const sprite = variant ? sprites[variant.id] : undefined;
      if (!sprite) throw new ApiError(500, 'internal_error', 'This asset has no sprite data.');

      // Content-addressed by nothing but the row's own updatedAt — an asset
      // has no separate "content changed" hash the way a layout's sha256
      // does, so this is short-lived + revalidated like the layout detail
      // route, never treated as immutable.
      reply.header('cache-control', 'public, max-age=60, must-revalidate');
      return reply.header('content-type', 'image/png').send(encodeSpritePng(sprite));
    },
  );
}
