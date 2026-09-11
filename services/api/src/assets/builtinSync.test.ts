import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PIXEL_AGENTS_SYSTEM_USER_ID } from '../db/constants.js';
import * as schema from '../db/schema.js';
import { createTestDatabase, type Harness } from '../db/test-support/harness.js';
import { tinyPng } from '../test-support/assetZip.js';
import { syncBuiltinAssets } from './builtinSync.js';
import { CHARACTER_HEIGHT, CHARACTER_WIDTH } from './decodeCharacter.js';
import { PET_HEIGHT, PET_WIDTH } from './decodePet.js';

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

/** A throwaway `vendor/pixel-agents`-shaped tree, valid enough for `upstreamPin()`/`upstreamAssetsDir()`. */
function writeFixtureVendor(opts: {
  commit?: string;
  furniture?: { id: string; category?: string }[];
  characterIndices?: number[];
  pets?: { id: string; name: string }[];
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-index-builtin-sync-test-'));
  const upstreamDir = path.join(root, 'pixel-agents');
  const assetsDir = path.join(upstreamDir, 'webview-ui/public/assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(upstreamDir, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
  if (opts.commit) fs.writeFileSync(`${upstreamDir}.commit`, opts.commit);

  if (opts.furniture?.length) {
    const furnitureDir = path.join(assetsDir, 'furniture');
    for (const item of opts.furniture) {
      const dir = path.join(furnitureDir, item.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'manifest.json'),
        // No `file` field — matching the real vendor tree's own convention
        // for a flat single-PNG item (upstream's own loader defaults it to
        // `<id>.png`; builtinSync.ts has to inject it before decode, since
        // the upload-validation schema requires it explicitly).
        JSON.stringify({
          id: item.id,
          name: item.id,
          category: item.category ?? 'chairs',
          type: 'asset',
          width: 16,
          height: 16,
          footprintW: 1,
          footprintH: 1,
          canPlaceOnWalls: false,
          canPlaceOnSurfaces: false,
          backgroundTiles: 0,
        }),
      );
      fs.writeFileSync(path.join(dir, `${item.id}.png`), tinyPng(16, 16));
    }
  }

  if (opts.characterIndices?.length) {
    const charactersDir = path.join(assetsDir, 'characters');
    fs.mkdirSync(charactersDir, { recursive: true });
    for (const n of opts.characterIndices) {
      fs.writeFileSync(path.join(charactersDir, `char_${n}.png`), tinyPng(CHARACTER_WIDTH, CHARACTER_HEIGHT));
    }
  }

  if (opts.pets?.length) {
    const petsDir = path.join(assetsDir, 'pets');
    for (const pet of opts.pets) {
      const dir = path.join(petsDir, pet.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: pet.id, name: pet.name }));
      fs.writeFileSync(path.join(dir, 'pet.png'), tinyPng(PET_WIDTH, PET_HEIGHT));
    }
  }

  return upstreamDir;
}

let harness: Harness | undefined;
const roots: string[] = [];
beforeEach(async () => {
  harness = await createTestDatabase();
});
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  for (const root of roots.splice(0)) fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

function db(): Harness['db'] {
  if (!harness) throw new Error('this test did not create a database');
  return harness.db;
}

function vendor(opts: Parameters<typeof writeFixtureVendor>[0]): string {
  const dir = writeFixtureVendor(opts);
  roots.push(dir);
  return dir;
}

async function builtinRows() {
  return db()
    .select()
    .from(schema.customAssets)
    .where(eq(schema.customAssets.source, 'builtin'))
    .orderBy(schema.customAssets.assetId);
}

describe('syncBuiltinAssets', () => {
  it('populates furniture, character, and pet rows on a fresh install', async () => {
    const upstreamDir = vendor({
      commit: COMMIT_A,
      furniture: [{ id: 'CHAIR' }],
      characterIndices: [0, 1],
      pets: [{ id: 'gitcat', name: 'Gitcat' }],
    });

    const result = await syncBuiltinAssets(db(), upstreamDir);
    expect(result).toEqual({ synced: true, count: 4, commit: COMMIT_A });

    const rows = await builtinRows();
    expect(rows.map((r) => r.assetId)).toEqual(['CHAIR', 'CHAR_0', 'CHAR_1', 'GITCAT']);
    for (const row of rows) {
      expect(row.source).toBe('builtin');
      expect(row.sourceCommit).toBe(COMMIT_A);
      expect(row.authorUserId).toBe(PIXEL_AGENTS_SYSTEM_USER_ID);
    }
    // Pet id upper-cased for storage; display name keeps its original casing.
    expect(rows.find((r) => r.assetId === 'GITCAT')?.name).toBe('Gitcat');
    // The fixture's flat furniture manifest has no `file` field (matching the
    // real vendor tree's own convention) — builtinSync.ts must inject
    // `<id>.png` before decode, or decodeFurnitureZip's schema validation
    // rejects every flat built-in item.
    const chair = rows.find((r) => r.assetId === 'CHAIR');
    expect((chair?.manifest as { file: string }[])[0]?.file).toBe('CHAIR.png');
  });

  it('re-running with an unchanged pin no-ops', async () => {
    const upstreamDir = vendor({ commit: COMMIT_A, furniture: [{ id: 'CHAIR' }] });
    await syncBuiltinAssets(db(), upstreamDir);
    const before = await builtinRows();

    const result = await syncBuiltinAssets(db(), upstreamDir);
    expect(result).toEqual({ synced: false, count: 0, commit: COMMIT_A });

    const after = await builtinRows();
    expect(after).toEqual(before);
  });

  it('a changed pin resyncs, dropping stale builtin rows and leaving custom rows untouched', async () => {
    const upstreamA = vendor({ commit: COMMIT_A, furniture: [{ id: 'CHAIR' }] });
    await syncBuiltinAssets(db(), upstreamA);

    const [customRow] = await db()
      .insert(schema.customAssets)
      .values({
        assetKind: 'furniture',
        assetId: 'MY_CUSTOM_ITEM',
        requestedAssetId: 'MY_CUSTOM_ITEM',
        name: 'My Custom Item',
        category: 'misc',
        manifest: [
          {
            id: 'MY_CUSTOM_ITEM',
            name: 'My Custom Item',
            label: 'My Custom Item',
            category: 'misc',
            file: 'MY_CUSTOM_ITEM.png',
            width: 16,
            height: 16,
            footprintW: 1,
            footprintH: 1,
            isDesk: false,
            canPlaceOnWalls: false,
            groupId: 'MY_CUSTOM_ITEM',
          },
        ],
        sprites: { MY_CUSTOM_ITEM: Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => '#ff00ff')) },
        rawZip: Buffer.from('fake zip'),
        authorUserId: PIXEL_AGENTS_SYSTEM_USER_ID,
        source: 'custom',
      })
      .returning();

    const upstreamB = vendor({ commit: COMMIT_B, furniture: [{ id: 'TABLE' }] });
    const result = await syncBuiltinAssets(db(), upstreamB);
    expect(result).toEqual({ synced: true, count: 1, commit: COMMIT_B });

    const rows = await builtinRows();
    expect(rows.map((r) => r.assetId)).toEqual(['TABLE']);
    expect(rows[0]?.sourceCommit).toBe(COMMIT_B);

    const [survivingCustom] = await db()
      .select()
      .from(schema.customAssets)
      .where(eq(schema.customAssets.assetId, 'MY_CUSTOM_ITEM'));
    expect(survivingCustom).toMatchObject({ id: customRow?.id, updatedAt: customRow?.updatedAt });
  });

  it('auto-suffixes a builtin asset that collides with an existing custom id', async () => {
    await db()
      .insert(schema.customAssets)
      .values({
        assetKind: 'furniture',
        assetId: 'CHAIR',
        requestedAssetId: 'CHAIR',
        name: 'A user-uploaded chair',
        category: 'chairs',
        manifest: [
          {
            id: 'CHAIR',
            name: 'A user-uploaded chair',
            label: 'A user-uploaded chair',
            category: 'chairs',
            file: 'CHAIR.png',
            width: 16,
            height: 16,
            footprintW: 1,
            footprintH: 1,
            isDesk: false,
            canPlaceOnWalls: false,
            groupId: 'CHAIR',
          },
        ],
        sprites: { CHAIR: Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => '#ff00ff')) },
        rawZip: Buffer.from('fake zip'),
        authorUserId: PIXEL_AGENTS_SYSTEM_USER_ID,
        source: 'custom',
      });

    const upstreamDir = vendor({ commit: COMMIT_A, furniture: [{ id: 'CHAIR' }] });
    await syncBuiltinAssets(db(), upstreamDir);

    const rows = await builtinRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ assetId: 'CHAIR_2', requestedAssetId: 'CHAIR' });

    const [custom] = await db().select().from(schema.customAssets).where(eq(schema.customAssets.assetId, 'CHAIR'));
    expect(custom?.source).toBe('custom');
  });

  it('is a safe no-op, deleting nothing, when the pinned commit cannot be resolved', async () => {
    const upstreamDir = vendor({ commit: COMMIT_A, furniture: [{ id: 'CHAIR' }] });
    await syncBuiltinAssets(db(), upstreamDir);

    // A vendor tree with no .commit stamp and no real git — upstreamPin() has nothing to resolve.
    const unpinnedDir = vendor({ furniture: [{ id: 'TABLE' }] });
    const result = await syncBuiltinAssets(db(), unpinnedDir);
    expect(result).toEqual({ synced: false, count: 0, commit: null });

    const rows = await builtinRows();
    expect(rows.map((r) => r.assetId)).toEqual(['CHAIR']);
  });
});
