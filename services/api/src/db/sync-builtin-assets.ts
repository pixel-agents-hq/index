#!/usr/bin/env node
/**
 * Sync the built-in Pixel Agents catalog into `custom_assets` against the
 * pinned commit — the boot-script wrapper around `assets/builtinSync.ts`,
 * same shape as `migrate.ts`/`backfill-seats.ts`/`seed.ts`, run once per
 * boot from `docker-entrypoint.sh`. Idempotent: a boot where the pin hasn't
 * moved since the last sync is a no-op.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { upstreamPin } from '@pixel-index/layout-core';

import { syncBuiltinAssets } from '../assets/builtinSync.js';
import { createDatabase } from './client.js';

// Only run when executed directly, so importing this for tests is harmless —
// same pattern as migrate.ts and seed.ts.
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  console.log(`Syncing built-in Pixel Agents assets against pixel-agents ${upstreamPin().version ?? 'unknown'}…`);
  const { db, pool } = createDatabase();
  syncBuiltinAssets(db)
    .then(() => pool.end())
    .catch((error: unknown) => {
      console.error('Built-in asset sync failed:', error);
      return pool.end().finally(() => process.exit(1));
    });
}
