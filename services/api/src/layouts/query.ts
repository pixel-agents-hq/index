/**
 * SQL for the public read paths: list (filtered, sorted, paginated), detail
 * by slug, and the small tag-lookup that decorates both.
 *
 * Kept free of Fastify so it can be tested directly against a database
 * without going through HTTP.
 */

import type { LayoutMeta } from '@pixel-index/layout-core';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import { newUserIdentity } from '../avatars/defaults.js';
import type { AnyDatabase } from '../db/client.js';
import { SYSTEM_USER_ID } from '../db/constants.js';
import { one } from '../db/rows.js';
import * as schema from '../db/schema.js';
import { type Cursor, decodeCursor, encodeCursor, type SortKey } from './cursor.js';

export interface NumericRange {
  min?: number;
  max?: number;
}

export interface ListLayoutsFilters {
  /**
   * users.id — the author to restrict to. Internal use only (moderation
   * search, owner queries) — this is the Pixel Index UUID, not what the
   * public API accepts. See `authorDiscordId` for the public equivalent.
   */
  author?: string;
  /**
   * users.discordId — the public author-facing filter (#61): a Discord user
   * id, resolved to the internal `author` id before the query runs. Not a
   * UUID, so it can't just be compared against `layouts.authorUserId`
   * directly — an unmatched id (or one that doesn't resolve to any user)
   * yields zero results rather than a Postgres type error.
   */
  authorDiscordId?: string;
  /** Tag names. A layout must have every one of these (AND, not OR). */
  tags?: string[];
  /** Free text over title and description, via the generated search_vector. */
  q?: string;
  /** The declared canvas allocation — not the occupied footprint. See `size` below for that. */
  cols?: NumericRange;
  rows?: NumericRange;
  /**
   * Occupied-footprint tile count (visibleCols × visibleRows), #24's "size is
   * filtered by square unit" — not cols/rows independently, and not the
   * declared canvas either (#55): a layout's canvas can be much bigger than
   * what it actually occupies.
   */
  size?: NumericRange;
  furniture?: NumericRange;
  areas?: NumericRange;
  pets?: NumericRange;
  seats?: NumericRange;
  /** Moderator-scope only: narrow to one visibility, e.g. "show me what's hidden". */
  visibility?: schema.Layout['visibility'];
}

/**
 * `public` is #6's whole world: every result filtered to `visibility =
 * 'public'`. `owner` is #9's `/me/layouts` — everything a user owns,
 * regardless of visibility, so a hidden layout does not just disappear on
 * its owner too. `moderator` is #15's moderation console — every layout
 * from every author, any visibility, since a moderator has to be able to
 * find something to act on before they can act on it.
 */
export type ListLayoutsScope =
  | { type: 'public' }
  | { type: 'owner'; userId: string }
  | { type: 'moderator' };

export interface ListLayoutsOptions {
  filters: ListLayoutsFilters;
  sort: SortKey;
  limit: number;
  /** An opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
  /** Defaults to `{ type: 'public' }` — every existing call site's behaviour. */
  scope?: ListLayoutsScope;
}

export interface ListLayoutsResult {
  rows: schema.Layout[];
  /** Every layout matching `filters`, ignoring pagination — for "N results". */
  total: number;
  nextCursor: string | null;
}

/** The SQL expression each sort key orders by. Shared between filtering, ordering and the cursor. */
function sortExpr(sort: SortKey) {
  switch (sort) {
    case 'newest':
      return schema.layouts.createdAt;
    case 'furniture':
      return schema.layouts.furnitureCount;
    case 'largest':
      // The occupied footprint, not the declared canvas (#55) — see
      // schema.ts's visibleCols/visibleRows. No dedicated index for this one
      // yet; fine at current scale, and #14 explicitly reserves the right to
      // ask for more indexing "once the UI is real".
      return sql`(${schema.layouts.visibleCols} * ${schema.layouts.visibleRows})`;
    case 'title':
      return schema.layouts.title;
  }
}

function isDescending(sort: SortKey): boolean {
  return sort !== 'title';
}

function buildFilterConditions(filters: ListLayoutsFilters, scope: ListLayoutsScope) {
  const conditions =
    scope.type === 'public'
      ? [eq(schema.layouts.visibility, 'public')]
      : scope.type === 'owner'
        ? [eq(schema.layouts.authorUserId, scope.userId)]
        : []; // moderator: no base condition — every author, every visibility.

  if (filters.author) conditions.push(eq(schema.layouts.authorUserId, filters.author));
  if (filters.visibility) conditions.push(eq(schema.layouts.visibility, filters.visibility));

  if (filters.tags && filters.tags.length > 0) {
    // ALL of the requested tags, not any — narrows further with each one
    // added, consistent with how the numeric ranges compose.
    //
    // `= ANY(${array})` looks tempting but is wrong here: drizzle's sql tag
    // expands a plain JS array into "(v1, v2, …)" — parenthesised scalars,
    // not a bound Postgres array literal — and `ANY()` requires a real array
    // on its right side, so this throws "op ANY/ALL (array) requires array on
    // right side" at query time, not at compile time. `IN (…)` built via
    // sql.join is the correct (and correctly parameterised) equivalent.
    const tagList = sql.join(
      filters.tags.map((tag) => sql`${tag}`),
      sql`, `,
    );
    conditions.push(sql`(
      SELECT count(*) FROM ${schema.layoutTags}
      INNER JOIN ${schema.tags} ON ${schema.tags.id} = ${schema.layoutTags.tagId}
      WHERE ${schema.layoutTags.layoutId} = ${schema.layouts.id}
        AND ${schema.tags.name} IN (${tagList})
    ) = ${filters.tags.length}`);
  }

  if (filters.q && filters.q.trim() !== '') {
    conditions.push(
      sql`${schema.layouts.searchVector} @@ plainto_tsquery('english', ${filters.q})`,
    );
  }

  for (const [range, column] of [
    [filters.cols, schema.layouts.cols],
    [filters.rows, schema.layouts.rows],
    [filters.furniture, schema.layouts.furnitureCount],
    [filters.areas, schema.layouts.areaCount],
    [filters.pets, schema.layouts.petCount],
    [filters.seats, schema.layouts.seatCount],
  ] as const) {
    if (range?.min !== undefined) conditions.push(gte(column, range.min));
    if (range?.max !== undefined) conditions.push(lte(column, range.max));
  }

  // Not a stored column, so it can't join the generic loop above — same
  // `(visibleCols * visibleRows)` expression `sortExpr('largest')` orders
  // by, filtered instead of sorted.
  if (filters.size?.min !== undefined) {
    conditions.push(
      sql`(${schema.layouts.visibleCols} * ${schema.layouts.visibleRows}) >= ${filters.size.min}`,
    );
  }
  if (filters.size?.max !== undefined) {
    conditions.push(
      sql`(${schema.layouts.visibleCols} * ${schema.layouts.visibleRows}) <= ${filters.size.max}`,
    );
  }

  return conditions;
}

/** `WHERE (sortExpr, id) < (cursor.value, cursor.id)`, direction-aware. */
function cursorCondition(sort: SortKey, cursor: Cursor) {
  const expr = sortExpr(sort);
  const op = isDescending(sort) ? sql`<` : sql`>`;
  return sql`(${expr}, ${schema.layouts.id}) ${op} (${cursor.value}, ${cursor.id})`;
}

export async function listLayouts(
  db: AnyDatabase,
  { filters, sort, limit, cursor: cursorParam, scope = { type: 'public' } }: ListLayoutsOptions,
): Promise<ListLayoutsResult> {
  let resolvedFilters = filters;
  if (filters.authorDiscordId) {
    const [authorRow] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.discordId, filters.authorDiscordId));
    // No user with that Discord id — same "not found is empty" shape as
    // every other filter, not a type error from comparing a snowflake
    // against the uuid-typed `authorUserId` column.
    if (!authorRow) return { rows: [], total: 0, nextCursor: null };
    resolvedFilters = { ...filters, author: authorRow.id };
  }
  const conditions = buildFilterConditions(resolvedFilters, scope);

  const [totalRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.layouts)
    .where(and(...conditions));
  const total = totalRow?.total ?? 0;

  const cursor = cursorParam ? decodeCursor(cursorParam, sort) : null;
  const whereClause = cursor
    ? and(...conditions, cursorCondition(sort, cursor))
    : and(...conditions);

  const expr = sortExpr(sort);
  const orderBy = isDescending(sort)
    ? [desc(expr), desc(schema.layouts.id)]
    : [asc(expr), asc(schema.layouts.id)];

  // One extra row, never returned, just to know whether a next page exists —
  // avoids a second COUNT for that alone.
  const page = await db
    .select()
    .from(schema.layouts)
    .where(whereClause)
    .orderBy(...orderBy)
    .limit(limit + 1);

  const hasMore = page.length > limit;
  const rows = hasMore ? page.slice(0, limit) : page;
  const lastRow = rows[rows.length - 1];

  const nextCursor =
    hasMore && lastRow
      ? encodeCursor({ sort, value: cursorValueOf(sort, lastRow), id: lastRow.id })
      : null;

  return { rows, total, nextCursor };
}

function cursorValueOf(sort: SortKey, row: schema.Layout): string | number {
  switch (sort) {
    case 'newest':
      return row.createdAt.toISOString();
    case 'furniture':
      return row.furnitureCount;
    case 'largest':
      return row.visibleCols * row.visibleRows;
    case 'title':
      return row.title;
  }
}

/** One line of the bulk export (#26). See export.ts for why `layout`, not `raw`. */
export interface PublicLayoutExportRow {
  slug: string;
  sha256: string;
  layoutRevision: number;
  pixelAgentsVersion: string | null;
  layout: unknown;
}

/**
 * Every public layout, in id order, a page at a time.
 *
 * A generator rather than an array because this is what the bulk export
 * streams from, and the whole point of streaming it is that neither the
 * server nor the client ever holds the entire index in memory. Keyset on
 * `id` (not OFFSET) for the same reason the list route uses a cursor: OFFSET
 * silently skips or repeats rows when something is inserted mid-scan.
 *
 * `id` alone is a total order here — it is the primary key — so unlike
 * listLayouts' cursor there is no tiebreaker to append.
 */
export async function* streamPublicLayouts(
  db: AnyDatabase,
  batchSize = 200,
): AsyncGenerator<PublicLayoutExportRow> {
  let after: string | null = null;

  for (;;) {
    const conditions = [eq(schema.layouts.visibility, 'public')];
    if (after !== null) conditions.push(sql`${schema.layouts.id} > ${after}`);

    const batch: schema.Layout[] = await db
      .select()
      .from(schema.layouts)
      .where(and(...conditions))
      .orderBy(asc(schema.layouts.id))
      .limit(batchSize);

    for (const row of batch) {
      yield {
        slug: row.slug,
        sha256: row.sha256,
        layoutRevision: row.layoutRevision,
        pixelAgentsVersion: row.pixelAgentsVersion,
        layout: row.layout,
      };
    }

    const lastRow = batch[batch.length - 1];
    if (!lastRow || batch.length < batchSize) return;
    after = lastRow.id;
  }
}

/**
 * Every layout worth backing up — `public` and `hidden`, in id order, a page
 * at a time (#63). `deleted` is excluded on purpose: PR #80's own rationale
 * for keeping `deleted` out of `seed/`'s meta.json shape applies exactly the
 * same way here — there is nothing worth backing up for a layout that is
 * gone for good.
 *
 * Same keyset-on-`id` shape as `streamPublicLayouts` just above, for the same
 * reason: a full backup is the other bulk consumer that must not hold the
 * whole table in memory or skip/repeat rows under OFFSET pagination.
 */
export async function* streamBackupLayouts(
  db: AnyDatabase,
  batchSize = 200,
): AsyncGenerator<schema.Layout> {
  let after: string | null = null;

  for (;;) {
    const conditions = [inArray(schema.layouts.visibility, ['public', 'hidden'])];
    if (after !== null) conditions.push(sql`${schema.layouts.id} > ${after}`);

    const batch: schema.Layout[] = await db
      .select()
      .from(schema.layouts)
      .where(and(...conditions))
      .orderBy(asc(schema.layouts.id))
      .limit(batchSize);

    yield* batch;

    const lastRow = batch[batch.length - 1];
    if (!lastRow || batch.length < batchSize) return;
    after = lastRow.id;
  }
}

/**
 * A cheap, exact fingerprint of the public set — what the export's ETag is
 * built from.
 *
 * Exact rather than approximate on purpose: this endpoint's main consumer is
 * the vendor-update gate (#26), which decides whether an upstream bump breaks
 * real layouts. A fingerprint that missed an edit would let that gate revalidate
 * a stale copy and report a verdict about layouts the index no longer holds.
 * `count` alone misses an edit-in-place; `max(updated_at)` alone misses a
 * deletion that happens to leave the newest row untouched — so the digest folds
 * in every row's content hash *and* its updated_at, and `count` rides along for
 * the `x-total-count` header the client uses to detect a truncated stream.
 */
export async function publicLayoutsFingerprint(
  db: AnyDatabase,
): Promise<{ count: number; digest: string }> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      // md5 over the ordered (sha256, updated_at) pairs. NULL for an empty
      // set, which would make the ETag `"null"` and compare equal to nothing —
      // coalesce so an empty index still gets a stable, matchable ETag.
      digest: sql<string>`coalesce(md5(string_agg(${schema.layouts.sha256} || ':' || ${schema.layouts.updatedAt}::text, ',' ORDER BY ${schema.layouts.id})), 'empty')`,
    })
    .from(schema.layouts)
    .where(eq(schema.layouts.visibility, 'public'));

  return { count: row?.count ?? 0, digest: row?.digest ?? 'empty' };
}

export async function countPublicLayouts(db: AnyDatabase): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.layouts)
    .where(eq(schema.layouts.visibility, 'public'));
  return row?.total ?? 0;
}

export interface TagUsage {
  name: string;
  count: number;
}

/**
 * Every tag used by at least one public layout, with how many — #14's tag
 * multi-select is populated from this rather than hardcoded, so it never
 * shows a tag with zero results and never needs updating by hand as the
 * vocabulary grows. Ordered by popularity: the tags worth showing first are
 * the ones actually narrowing something.
 */
export async function listPublicTags(db: AnyDatabase): Promise<TagUsage[]> {
  const rows = await db
    .select({ name: schema.tags.name, count: sql<number>`count(*)::int` })
    .from(schema.layoutTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.layoutTags.tagId))
    .innerJoin(schema.layouts, eq(schema.layouts.id, schema.layoutTags.layoutId))
    .where(eq(schema.layouts.visibility, 'public'))
    .groupBy(schema.tags.name)
    .orderBy(sql`count(*) DESC`, schema.tags.name);
  return rows;
}

export async function getLayoutBySlug(db: AnyDatabase, slug: string): Promise<schema.Layout | null> {
  const [row] = await db
    .select()
    .from(schema.layouts)
    .where(and(eq(schema.layouts.slug, slug), eq(schema.layouts.visibility, 'public')));
  return row ?? null;
}

/**
 * Same lookup, no visibility filter — for the owner/moderator write routes
 * (manage.ts), which have to be able to find and act on a layout that is
 * already hidden or deleted (to edit or hide/unhide it, or to delete it).
 * #6's public read paths must never use this one.
 */
export async function getLayoutBySlugAnyVisibility(
  db: AnyDatabase,
  slug: string,
): Promise<schema.Layout | null> {
  const [row] = await db.select().from(schema.layouts).where(eq(schema.layouts.slug, slug));
  return row ?? null;
}

/** Tag names for a set of layouts, grouped by layout id. Empty array for a layout with none. */
export async function tagsForLayouts(
  db: AnyDatabase,
  layoutIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>(layoutIds.map((id) => [id, []]));
  if (layoutIds.length === 0) return map;

  const rows = await db
    .select({ layoutId: schema.layoutTags.layoutId, name: schema.tags.name })
    .from(schema.layoutTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.layoutTags.tagId))
    .where(inArray(schema.layoutTags.layoutId, layoutIds));

  for (const row of rows) map.get(row.layoutId)?.push(row.name);
  return map;
}

export async function authorForLayout(
  db: AnyDatabase,
  authorUserId: string,
): Promise<schema.User | null> {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, authorUserId));
  return row ?? null;
}

export async function authorsForLayouts(
  db: AnyDatabase,
  authorUserIds: string[],
): Promise<Map<string, schema.User>> {
  if (authorUserIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(schema.users)
    .where(inArray(schema.users.id, [...new Set(authorUserIds)]));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * By content hash, **regardless of visibility** — dedupe (#8) has to catch a
 * resubmission of hidden or deleted content too, not just public, or a
 * DIFFERENT owner could re-upload someone else's non-public layout
 * byte-for-byte under a fresh slug. The one deliberate exception (manage.ts/
 * submit.ts's `isOwnersOwnDeleted` check) is the SAME owner resubmitting
 * their own `deleted` layout — allowed even if a moderator was the one who
 * deleted it (#72): abuse of that is a Discord-membership problem, not
 * something dedupe enforces.
 */
export async function findLayoutBySha256(
  db: AnyDatabase,
  sha256: string,
): Promise<schema.Layout | null> {
  const [row] = await db.select().from(schema.layouts).where(eq(schema.layouts.sha256, sha256));
  return row ?? null;
}

/** For the per-user daily submission cap (#8). */
export async function countUserSubmissionsSince(
  db: AnyDatabase,
  userId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.layouts)
    .where(and(eq(schema.layouts.authorUserId, userId), gte(schema.layouts.createdAt, since)));
  return row?.total ?? 0;
}

/**
 * Resolve `meta.json`'s `author`/`authorDiscordId` (`LayoutMeta`) to a real
 * owner row — the system user with a display-name fallback when no Discord id
 * is given, or a real/newly-created linked account when one is. Shared by
 * `db/seed.ts` (bootstrap) and the admin backup import (#63) so the two never
 * carry two hand-written copies of the same resolution rule, the exact
 * drift #80 found between `SeedMeta` and `LayoutMeta` before this existed.
 */
export async function resolveAuthorFromMeta(
  db: AnyDatabase,
  meta: Pick<LayoutMeta, 'author' | 'authorDiscordId'>,
): Promise<{ authorUserId: string; authorDisplay: string | null }> {
  if (!meta.authorDiscordId) {
    return { authorUserId: SYSTEM_USER_ID, authorDisplay: meta.author };
  }

  const [known] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.discordId, meta.authorDiscordId));
  if (known) return { authorUserId: known.id, authorDisplay: null };

  const created = one(
    await db
      .insert(schema.users)
      .values({ ...newUserIdentity(), discordId: meta.authorDiscordId, username: meta.author })
      .returning({ id: schema.users.id }),
  );
  return { authorUserId: created.id, authorDisplay: null };
}

/**
 * Create-or-reuse each tag by name, then attach every one to the layout.
 * Tag names are validated by the caller (layout-core's `SLUG_RE`, the same
 * pattern `tags_name_format` enforces) before this ever runs.
 */
export async function attachTags(
  db: AnyDatabase,
  layoutId: string,
  tagNames: string[],
): Promise<void> {
  if (tagNames.length === 0) return;

  const unique = [...new Set(tagNames)];
  const existing = await db.select().from(schema.tags).where(inArray(schema.tags.name, unique));
  const existingNames = new Set(existing.map((tag) => tag.name));
  const toCreate = unique.filter((name) => !existingNames.has(name));

  const created =
    toCreate.length > 0
      ? await db
          .insert(schema.tags)
          .values(toCreate.map((name) => ({ name })))
          .returning()
      : [];

  const allTags = [...existing, ...created];
  await db.insert(schema.layoutTags).values(allTags.map((tag) => ({ layoutId, tagId: tag.id })));
}

/**
 * Sets a layout's tags to exactly `tagNames` — clears every existing
 * association first. `attachTags` only adds; an edit (`PATCH`, #9/#10) needs
 * to be able to remove a tag too, not just append new ones.
 */
export async function replaceTags(
  db: AnyDatabase,
  layoutId: string,
  tagNames: string[],
): Promise<void> {
  await db.delete(schema.layoutTags).where(eq(schema.layoutTags.layoutId, layoutId));
  await attachTags(db, layoutId, tagNames);
}
