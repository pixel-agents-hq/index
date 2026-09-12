import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { backfillAssetTags } from './backfill-asset-tags.js';
import { PIXEL_AGENTS_SYSTEM_USER_ID } from './constants.js';
import * as schema from './schema.js';
import { createTestDatabase, type Harness } from './test-support/harness.js';

let harness: Harness | undefined;
beforeEach(async () => {
  harness = await createTestDatabase();
});
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function db(): Harness['db'] {
  if (!harness) throw new Error('this test did not create a database');
  return harness.db;
}

/** PC's own manifest shape (docs/external-assets.md's reference example) — both static and animated, plus interactable. */
const PC_MANIFEST = [
  {
    id: 'PC_FRONT_ON_1',
    name: 'PC',
    label: 'PC',
    category: 'electronics',
    file: 'PC_FRONT_ON_1.png',
    width: 16,
    height: 32,
    footprintW: 1,
    footprintH: 2,
    isDesk: false,
    canPlaceOnWalls: false,
    groupId: 'PC',
    orientation: 'front',
    state: 'on',
    animationGroup: 'PC_FRONT_ON',
    frame: 0,
  },
  {
    id: 'PC_FRONT_OFF',
    name: 'PC',
    label: 'PC',
    category: 'electronics',
    file: 'PC_FRONT_OFF.png',
    width: 16,
    height: 32,
    footprintW: 1,
    footprintH: 2,
    isDesk: false,
    canPlaceOnWalls: false,
    groupId: 'PC',
    orientation: 'front',
    state: 'off',
  },
  {
    id: 'PC_BACK',
    name: 'PC',
    label: 'PC',
    category: 'electronics',
    file: 'PC_BACK.png',
    width: 16,
    height: 32,
    footprintW: 1,
    footprintH: 2,
    isDesk: false,
    canPlaceOnWalls: false,
    groupId: 'PC',
    orientation: 'back',
  },
];

async function insertAsset(overrides: Partial<schema.NewCustomAsset> = {}): Promise<schema.CustomAsset> {
  const [row] = await db()
    .insert(schema.customAssets)
    .values({
      assetKind: 'furniture',
      assetId: 'PC',
      requestedAssetId: 'PC',
      name: 'PC',
      category: 'electronics',
      manifest: PC_MANIFEST,
      sprites: {},
      rawZip: Buffer.from('fake zip'),
      authorUserId: PIXEL_AGENTS_SYSTEM_USER_ID,
      source: 'builtin',
      sourceCommit: '0'.repeat(40),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('insert did not return a row');
  return row;
}

describe('backfillAssetTags', () => {
  it('corrects a furniture row whose tags predate the column — PC ends up both static and animated', async () => {
    // The column default ('{}') is exactly what a pre-migration row looks
    // like: real manifest data, but tags Postgres backfilled empty rather
    // than computed.
    const stored = await insertAsset();
    expect(stored.tags).toEqual([]);

    const updated = await backfillAssetTags(db());
    expect(updated).toBe(1);

    const [row] = await db().select().from(schema.customAssets).where(eq(schema.customAssets.id, stored.id));
    expect(row?.tags.sort()).toEqual(['animated', 'back', 'front', 'interactable', 'static'].sort());
  });

  it('corrects a character/pet row to always exactly ["animated"]', async () => {
    const stored = await insertAsset({
      assetKind: 'pet',
      assetId: 'GITCAT',
      requestedAssetId: 'GITCAT',
      category: null,
      manifest: [{ id: 'GITCAT', name: 'Git Cat', width: 96, height: 96 }],
    });
    expect(stored.tags).toEqual([]);

    const updated = await backfillAssetTags(db());
    expect(updated).toBe(1);

    const [row] = await db().select().from(schema.customAssets).where(eq(schema.customAssets.id, stored.id));
    expect(row?.tags).toEqual(['animated']);
  });

  it('is idempotent — a second pass touches nothing once tags are correct', async () => {
    await insertAsset();
    await backfillAssetTags(db());
    const secondPass = await backfillAssetTags(db());
    expect(secondPass).toBe(0);
  });

  it('leaves an already-correct tags array alone', async () => {
    const stored = await insertAsset({ tags: ['front', 'back', 'static', 'animated', 'interactable'] });
    const updated = await backfillAssetTags(db());
    expect(updated).toBe(0);

    const [row] = await db().select().from(schema.customAssets).where(eq(schema.customAssets.id, stored.id));
    expect(row?.tags.sort()).toEqual(['animated', 'back', 'front', 'interactable', 'static'].sort());
  });
});
