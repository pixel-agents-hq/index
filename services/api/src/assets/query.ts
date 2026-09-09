/** SQL for custom assets: list (newest, optional category/author filter), detail, insert-time lookups. */

import { and, desc, eq, sql } from 'drizzle-orm';

import type { AnyDatabase } from '../db/client.js';
import * as schema from '../db/schema.js';
import { type Cursor, decodeCursor, encodeCursor } from '../layouts/cursor.js';

export interface ListCustomAssetsFilters {
  assetKind?: schema.CustomAsset['assetKind'];
  category?: string;
  /** users.id — resolved from a Discord id by the caller, same convention as layouts. */
  author?: string;
}

export interface ListCustomAssetsOptions {
  filters: ListCustomAssetsFilters;
  limit: number;
  cursor?: string;
}

export interface ListCustomAssetsResult {
  rows: schema.CustomAsset[];
  total: number;
  nextCursor: string | null;
}

/** #101 ships one sort order (newest) — this is the literal `layouts/cursor.ts` accepts. */
const SORT = 'newest' as const;

function buildConditions(filters: ListCustomAssetsFilters) {
  const conditions = [];
  if (filters.assetKind) conditions.push(eq(schema.customAssets.assetKind, filters.assetKind));
  if (filters.category) conditions.push(eq(schema.customAssets.category, filters.category));
  if (filters.author) conditions.push(eq(schema.customAssets.authorUserId, filters.author));
  return conditions;
}

function cursorCondition(cursor: Cursor) {
  return sql`(${schema.customAssets.createdAt}, ${schema.customAssets.id}) < (${cursor.value}, ${cursor.id})`;
}

export async function listCustomAssets(
  db: AnyDatabase,
  { filters, limit, cursor: cursorParam }: ListCustomAssetsOptions,
): Promise<ListCustomAssetsResult> {
  const conditions = buildConditions(filters);

  const [totalRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.customAssets)
    .where(and(...conditions));
  const total = totalRow?.total ?? 0;

  const cursor = cursorParam ? decodeCursor(cursorParam, SORT) : null;
  const whereClause = cursor ? and(...conditions, cursorCondition(cursor)) : and(...conditions);

  const page = await db
    .select()
    .from(schema.customAssets)
    .where(whereClause)
    .orderBy(desc(schema.customAssets.createdAt), desc(schema.customAssets.id))
    .limit(limit + 1);

  const hasMore = page.length > limit;
  const rows = hasMore ? page.slice(0, limit) : page;
  const lastRow = rows[rows.length - 1];

  const nextCursor =
    hasMore && lastRow
      ? encodeCursor({ sort: SORT, value: lastRow.createdAt.toISOString(), id: lastRow.id })
      : null;

  return { rows, total, nextCursor };
}

export async function getCustomAssetByAssetId(
  db: AnyDatabase,
  assetId: string,
): Promise<schema.CustomAsset | null> {
  const [row] = await db.select().from(schema.customAssets).where(eq(schema.customAssets.assetId, assetId));
  return row ?? null;
}

/** Every custom-asset root id currently in use — the DB half of the id-collision check. */
export async function existingCustomAssetIds(db: AnyDatabase): Promise<Set<string>> {
  const rows = await db.select({ assetId: schema.customAssets.assetId }).from(schema.customAssets);
  return new Set(rows.map((row) => row.assetId));
}

/**
 * Every published custom **furniture** asset's catalog entries + sprites —
 * the browser/renderer furniture-catalog merge endpoint
 * (`GET /api/v1/assets/catalog`, merged into pixel-agents' own furniture
 * catalog by `apps/web`'s `live-office/assets.ts`). Scoped to furniture only
 * (#105): a character or pet manifest entry has none of `CatalogEntry`'s
 * shape and must never be merged into the furniture catalog.
 */
export async function allCustomAssetCatalog(
  db: AnyDatabase,
): Promise<{ catalog: unknown[]; sprites: Record<string, string[][]> }> {
  const rows = await db
    .select()
    .from(schema.customAssets)
    .where(eq(schema.customAssets.assetKind, 'furniture'));
  const catalog: unknown[] = [];
  const sprites: Record<string, string[][]> = {};
  for (const row of rows) {
    catalog.push(...(row.manifest as unknown[]));
    Object.assign(sprites, row.sprites as Record<string, string[][]>);
  }
  return { catalog, sprites };
}

/** Every published custom asset of one non-furniture kind — the renderer packaging boundary reads this directly (#105). */
export async function customAssetsOfKind(
  db: AnyDatabase,
  assetKind: 'character' | 'pet',
): Promise<schema.CustomAsset[]> {
  return db.select().from(schema.customAssets).where(eq(schema.customAssets.assetKind, assetKind));
}
