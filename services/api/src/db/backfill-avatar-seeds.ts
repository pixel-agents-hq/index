#!/usr/bin/env node
/**
 * Deal a default avatar seed (#133) to every user row that has none.
 *
 * Migration 0020 added `users.avatar_seed` as nullable: dealing a seed code
 * needs pixatar's wardrobe, not something plain SQL can do. New rows get theirs
 * on insert (avatars/defaults.ts); this fills the rows from before the column.
 * It never rewrites a seed that is set, so running it before every boot (from
 * docker-entrypoint.sh, like the other backfills) is a no-op once it has run,
 * and a later vendor bump cannot re-deal anyone's avatar.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VENDOR } from '@pixel-index/pixatar';
import { and, eq, isNull } from 'drizzle-orm';

import { defaultAvatarSeed } from '../avatars/defaults.js';
import { type AnyDatabase, createDatabase } from './client.js';
import * as schema from './schema.js';

export async function backfillAvatarSeeds(db: AnyDatabase): Promise<number> {
  const rows = await db.select({ id: schema.users.id }).from(schema.users).where(isNull(schema.users.avatarSeed));

  for (const row of rows) {
    // `IS NULL` again in the update, so a row given its seed by an insert or a
    // concurrent run in the meantime keeps it.
    await db
      .update(schema.users)
      .set({ avatarSeed: defaultAvatarSeed(row.id) })
      .where(and(eq(schema.users.id, row.id), isNull(schema.users.avatarSeed)));
  }

  console.log(`Dealt a default avatar seed to ${rows.length} user(s).`);
  return rows.length;
}

// Only run when executed directly, so importing this for tests is harmless —
// same pattern as migrate.ts and seed.ts.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  console.log(`Backfilling users.avatar_seed with pixatar against pixel-agents ${VENDOR.version}…`);
  const { db, pool } = createDatabase();
  backfillAvatarSeeds(db)
    .then(() => pool.end())
    .catch((error: unknown) => {
      console.error('Backfill failed:', error);
      return pool.end().finally(() => process.exit(1));
    });
}
