/**
 * The public custom-asset API (#101) — reading is public, mirroring
 * `layouts/routes.ts`. No auth anywhere in this file.
 */

import { customAssetFurnitureManifestSchema, customAssetPetManifestSchema } from '@pixel-index/layout-core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { AnyDatabase } from '../db/client.js';
import * as schema from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { RequestSchemas } from '../http.js';
import { authorForLayout, authorsForLayouts } from '../layouts/query.js';
import type { CharacterFrames } from './decodeCharacter.js';
import type { PetFrames } from './decodePet.js';
import type { FlattenedAsset } from './manifest.js';
import { buildAssetPoses } from './poses.js';
import { allCustomAssetCatalog, listCustomAssets } from './query.js';
import {
  assetFramesResponseSchema,
  assetIdParamsSchema,
  assetManifestSchemaResponseSchema,
  assetSchemaKindParamsSchema,
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

/**
 * The single flat pixel grid a gallery thumbnail can show, whatever shape
 * `asset.sprites` actually holds for this `assetKind` (#105) — furniture is
 * already a flat grid per variant; character and pet are frame-array
 * structures, so the thumbnail is their down-facing first frame.
 */
function representativeSpriteGrid(asset: schema.CustomAsset): string[][] | undefined {
  const manifest = asset.manifest as unknown[];
  const sprites = asset.sprites as Record<string, unknown>;
  switch (asset.assetKind) {
    case 'furniture': {
      const variant = representativeVariant(manifest as FlattenedAsset[]);
      return variant ? (sprites[variant.id] as string[][] | undefined) : undefined;
    }
    case 'character': {
      const id = (manifest[0] as { id: string } | undefined)?.id;
      const frames = id ? (sprites[id] as CharacterFrames | undefined) : undefined;
      return frames?.down[0];
    }
    case 'pet': {
      const id = (manifest[0] as { id: string } | undefined)?.id;
      const frames = id ? (sprites[id] as PetFrames | undefined) : undefined;
      return frames?.idleDown[0] ?? frames?.walkDown[0];
    }
  }
}

/**
 * `character` has no manifest.json at all (#105) — nothing to publish a
 * schema for, so it's `undefined` here and the route 404s with a pointer to
 * where its PNG-only rule actually lives.
 */
function manifestSchemaFor(kind: 'furniture' | 'character' | 'pet'): object | undefined {
  switch (kind) {
    case 'furniture':
      return customAssetFurnitureManifestSchema;
    case 'pet':
      return customAssetPetManifestSchema;
    case 'character':
      return undefined;
  }
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
          ...(query.assetKind ? { assetKind: query.assetKind } : {}),
          ...(query.category ? { category: query.category } : {}),
          ...(query.source ? { source: query.source } : {}),
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

  // Public, unauthenticated, and live — a consumer generating upload zips
  // (pixel-art-mcp's contract check, #107) can fetch the manifest contract
  // straight from a running instance instead of hardcoding a
  // raw.githubusercontent.com path to this repo out of band. Registered
  // before `/api/v1/assets/:assetId` in this file, but the extra path
  // segment already keeps find-my-way from ever treating "schema" as an
  // `:assetId` value — the same reason `/api/v1/assets/catalog` doesn't
  // collide with it either.
  typed.get(
    '/api/v1/assets/schema/:kind',
    { schema: { params: assetSchemaKindParamsSchema, response: assetManifestSchemaResponseSchema } },
    async (request, reply) => {
      const { kind } = request.params;
      const manifestSchema = manifestSchemaFor(kind);
      if (!manifestSchema) {
        throw ApiError.notFound(
          `assetKind "${kind}" has no manifest.json, so there is no JSON Schema for it — see ` +
            'docs/custom-asset-zip-contract.md for its PNG-only rule instead.',
        );
      }
      reply.header('cache-control', 'public, max-age=3600');
      return manifestSchema;
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

      const sprite = representativeSpriteGrid(asset);
      if (!sprite) throw new ApiError(500, 'internal_error', 'This asset has no sprite data.');

      // Content-addressed by nothing but the row's own updatedAt — an asset
      // has no separate "content changed" hash the way a layout's sha256
      // does, so this is short-lived + revalidated like the layout detail
      // route, never treated as immutable.
      reply.header('cache-control', 'public, max-age=60, must-revalidate');
      return reply.header('content-type', 'image/png').send(encodeSpritePng(sprite));
    },
  );

  /**
   * Every pose this asset can be shown in — furniture's orientations/states,
   * a character's or pet's walking directions — each with its own frames
   * embedded as PNG data URLs, so a preview can animate and let visitors
   * switch variants without a request per frame.
   */
  typed.get(
    '/api/v1/assets/:assetId/frames',
    { schema: { params: assetIdParamsSchema, response: assetFramesResponseSchema } },
    async (request, reply) => {
      const { assetId } = request.params;
      const [asset] = await db.select().from(schema.customAssets).where(eq(schema.customAssets.assetId, assetId));
      if (!asset) throw ApiError.notFound(`No custom asset "${assetId}".`);

      reply.header('cache-control', 'public, max-age=60, must-revalidate');
      return { schemaVersion: SCHEMA_VERSION, poses: buildAssetPoses(asset) };
    },
  );
}
