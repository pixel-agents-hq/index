/** SQL for custom assets: list (newest, optional category/author filter), detail, insert-time lookups. */

import { and, arrayContains, arrayOverlaps, desc, eq, not, sql } from 'drizzle-orm';

import type { AnyDatabase } from '../db/client.js';
import * as schema from '../db/schema.js';
import { type Cursor, decodeCursor, encodeCursor, timestampMicros } from '../layouts/cursor.js';
import { INTERACTABLE_TAG } from './tags.js';

export interface ListCustomAssetsFilters {
  assetKind?: schema.CustomAsset['assetKind'];
  category?: string;
  source?: schema.CustomAsset['source'];
  /** users.id — resolved from a Discord id by the caller, same convention as layouts. */
  author?: string;
  /**
   * The tag facet filter (`assets/tags.ts`). Each present facet is OR'd
   * internally ("front OR back") and the facets present are AND'd together
   * ("(front OR back) AND animated") — see `buildConditions` below for why
   * this is deliberately not layouts' single all-tags-ANDed `tags` filter.
   */
  orientation?: string[];
  animation?: string[];
  /** Has (true) or lacks (false) the `interactable` tag. */
  interactable?: boolean;
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

/**
 * The tag facet filter's semantics, chosen deliberately over copying either
 * existing tag-filter precedent in this codebase:
 *
 * - NOT layouts' `tags` filter (`layouts/query.ts`) — "a layout must have
 *   EVERY requested tag" is a single flat AND-across-everything bag that
 *   doesn't distinguish facets, which is wrong here: selecting 'front' AND
 *   'back' under that model would require one asset to somehow be both at
 *   once, always returning nothing.
 * - Instead: these three facets (orientation, animation status,
 *   interactable) are OR'd *within* a facet ("front OR back" — matches
 *   the owner's own "it is possible to have multiple tags... not an
 *   exclusive filter") and AND'd *across* facets that are actually present
 *   ("(front OR back) AND animated" narrows further, same as every other
 *   filter in this list already composes).
 */
function buildConditions(filters: ListCustomAssetsFilters) {
  const conditions = [];
  if (filters.assetKind) conditions.push(eq(schema.customAssets.assetKind, filters.assetKind));
  if (filters.category) conditions.push(eq(schema.customAssets.category, filters.category));
  if (filters.source) conditions.push(eq(schema.customAssets.source, filters.source));
  if (filters.author) conditions.push(eq(schema.customAssets.authorUserId, filters.author));
  if (filters.orientation && filters.orientation.length > 0) {
    conditions.push(arrayOverlaps(schema.customAssets.tags, filters.orientation));
  }
  if (filters.animation && filters.animation.length > 0) {
    conditions.push(arrayOverlaps(schema.customAssets.tags, filters.animation));
  }
  if (filters.interactable !== undefined) {
    const hasTag = arrayContains(schema.customAssets.tags, [INTERACTABLE_TAG]);
    conditions.push(filters.interactable ? hasTag : not(hasTag));
  }
  return conditions;
}

function cursorCondition(cursor: Cursor) {
  return sql`(${timestampMicros(schema.customAssets.createdAt)}, ${schema.customAssets.id}) < (${cursor.value}, ${cursor.id})`;
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

  let nextCursor: string | null = null;
  if (hasMore && lastRow) {
    // lastRow.createdAt.toISOString() would truncate to millisecond
    // precision — see timestampMicros()'s doc comment for why that silently
    // drops rows that tie with it at microsecond precision.
    const [micros] = await db
      .select({ value: timestampMicros(schema.customAssets.createdAt) })
      .from(schema.customAssets)
      .where(eq(schema.customAssets.id, lastRow.id));
    nextCursor = encodeCursor({ sort: SORT, value: micros?.value ?? lastRow.createdAt.getTime() * 1000, id: lastRow.id });
  }

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
 *
 * Also scoped to `source: 'custom'` — `apps/web`'s build-time static bundle
 * (`apps/web/build/liveOfficeAssets.ts`) already independently decodes every
 * *built-in* furniture item from the same pinned vendor tree, so a builtin
 * `custom_assets` row (synced by `builtinSync.ts`) must never be merged in
 * here too, or every built-in furniture item would appear twice in the
 * palette.
 */
export async function allCustomAssetCatalog(
  db: AnyDatabase,
): Promise<{ catalog: unknown[]; sprites: Record<string, string[][]> }> {
  const rows = await db
    .select()
    .from(schema.customAssets)
    .where(and(eq(schema.customAssets.assetKind, 'furniture'), eq(schema.customAssets.source, 'custom')));
  const catalog: unknown[] = [];
  const sprites: Record<string, string[][]> = {};
  for (const row of rows) {
    catalog.push(...(row.manifest as unknown[]));
    Object.assign(sprites, row.sprites as Record<string, string[][]>);
  }
  return { catalog, sprites };
}

/**
 * Every published custom asset of one non-furniture kind — the renderer
 * packaging boundary reads this directly (#105).
 *
 * Scoped to `source: 'custom'` — `services/renderer` boots the pinned
 * upstream's own unmodified webview-ui, which already draws every *built-in*
 * character/pet natively; a builtin `custom_assets` row (synced by
 * `builtinSync.ts`) must never be injected on top of that too, or every
 * built-in character/pet would be double-drawn on every render.
 */
export async function customAssetsOfKind(
  db: AnyDatabase,
  assetKind: 'character' | 'pet',
): Promise<schema.CustomAsset[]> {
  return db
    .select()
    .from(schema.customAssets)
    .where(and(eq(schema.customAssets.assetKind, assetKind), eq(schema.customAssets.source, 'custom')));
}
