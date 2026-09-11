/**
 * Keyset (cursor) pagination, not OFFSET.
 *
 * OFFSET silently skips or repeats rows when the underlying set changes
 * between page requests — a layout published while someone is browsing page 2
 * shifts everything after it. A cursor pins to a row, not a position:
 * `WHERE (sortColumn, id) < (cursorValue, cursorId)` is stable regardless of
 * what gets inserted elsewhere, because `id` makes the ordering total even
 * when two rows tie on the sort column itself (two layouts published in the
 * same second, two layouts with the same furniture count, …).
 */

import { type SQL, sql, type SQLWrapper } from 'drizzle-orm';

export type SortKey = 'newest' | 'furniture' | 'largest' | 'title';

export interface Cursor {
  sort: SortKey;
  /** The sort column's value on the last row of the previous page. */
  value: string | number;
  /** Tiebreaker — the last row's id. */
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

/** Returns `null` for anything malformed, or a cursor whose `sort` does not match. */
export function decodeCursor(raw: string, expectedSort: SortKey): Cursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('sort' in parsed) ||
    !('value' in parsed) ||
    !('id' in parsed)
  ) {
    return null;
  }
  const candidate = parsed as Cursor;
  if (candidate.sort !== expectedSort) return null;
  if (typeof candidate.value !== 'string' && typeof candidate.value !== 'number') return null;
  if (typeof candidate.id !== 'string') return null;
  return candidate;
}

/**
 * Epoch-microseconds for a `timestamp` column/expression — use this, not
 * `date.toISOString()`, for any 'newest'-sort cursor value.
 *
 * JS `Date` only has millisecond resolution, so `row.createdAt.toISOString()`
 * truncates whatever sub-millisecond precision Postgres actually stored.
 * `now()` (every `createdAt` default) reliably carries microsecond
 * precision, and a bulk insert that shares one `now()` call across many rows
 * (e.g. `builtinSync.ts`'s reconciliation) makes many rows tie on it
 * exactly. A truncated cursor value then sits strictly *below* the true
 * value shared by every one of those tied rows, so none of them satisfy `<`
 * or `=` against it on the next page — they silently vanish instead of
 * paginating in. Comparing epoch microseconds (a plain integer, safely
 * inside JS's safe-integer range for centuries) instead of the formatted
 * string sidesteps the truncation entirely.
 */
export function timestampMicros(expr: SQLWrapper): SQL<number> {
  return sql<number>`(extract(epoch from ${expr}) * 1000000)`;
}
