#!/usr/bin/env node
/**
 * Recompute `custom_assets.tags` for every existing row from its stored
 * `manifest` column and correct any that disagree.
 *
 * Migration 0017 added `tags` as `NOT NULL DEFAULT '{}'`, which is right for
 * new rows (`submit.ts`/`builtinSync.ts` both set it from `assets/tags.ts`
 * now) but wrong for rows written before this column existed — Postgres
 * backfills those with the column default (an empty array), not real tags.
 * Same shape as `backfill-seats.ts`/`backfill-visible-bounds.ts`: a one-off,
 * idempotent companion run once per boot from `docker-entrypoint.sh`, since a
 * schema migration alone has no way to compute real tags for pre-existing
 * data.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';

import type { FlattenedAsset } from '../assets/manifest.js';
import { facingAssetTags, furnitureTags } from '../assets/tags.js';
import { type AnyDatabase, createDatabase } from './client.js';
import * as schema from './schema.js';

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((tag) => bSet.has(tag));
}

export async function backfillAssetTags(db: AnyDatabase): Promise<number> {
  const rows = await db
    .select({ id: schema.customAssets.id, assetKind: schema.customAssets.assetKind, manifest: schema.customAssets.manifest, tags: schema.customAssets.tags })
    .from(schema.customAssets);

  let updated = 0;
  for (const row of rows) {
    const tags =
      row.assetKind === 'furniture' ? furnitureTags(row.manifest as FlattenedAsset[]) : facingAssetTags();
    if (sameTags(tags, row.tags)) continue;
    await db.update(schema.customAssets).set({ tags }).where(eq(schema.customAssets.id, row.id));
    updated += 1;
  }

  console.log(`Checked ${rows.length} asset(s), corrected tags on ${updated}.`);
  return updated;
}

// Only run when executed directly, so importing this for tests is harmless —
// same pattern as migrate.ts/seed.ts/backfill-seats.ts.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  console.log('Backfilling custom_assets.tags…');
  const { db, pool } = createDatabase();
  backfillAssetTags(db)
    .then(() => pool.end())
    .catch((error: unknown) => {
      console.error('Backfill failed:', error);
      return pool.end().finally(() => process.exit(1));
    });
}
