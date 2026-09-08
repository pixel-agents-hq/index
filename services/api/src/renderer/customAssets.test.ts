import { describe, expect, it } from 'vitest';

import * as schema from '../db/schema.js';
import { createTestDatabase, type Harness } from '../db/test-support/harness.js';
import { insertUser } from '../test-support/layouts.js';
import { customAssetsForLayout } from './customAssets.js';

async function insertCustomAsset(harness: Harness, assetId: string) {
  const user = await insertUser(harness.db, { username: `author-of-${assetId}` });
  await harness.db.insert(schema.customAssets).values({
    assetId,
    requestedAssetId: assetId,
    name: assetId,
    category: 'chairs',
    manifest: [
      {
        id: assetId,
        name: assetId,
        label: assetId,
        category: 'chairs',
        file: `${assetId}.png`,
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        canPlaceOnWalls: false,
        groupId: assetId,
      },
    ],
    sprites: { [assetId]: Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => '#ff00ff')) },
    rawZip: Buffer.from('fake zip'),
    authorUserId: user.id,
  });
}

describe('customAssetsForLayout', () => {
  it('returns nothing for a layout with no furniture', async () => {
    const harness = await createTestDatabase();
    try {
      await insertCustomAsset(harness, 'UNUSED_CHAIR');
      const result = await customAssetsForLayout(harness.db, { version: 1, cols: 1, rows: 1, tiles: [0], furniture: [] });
      expect(result).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('returns nothing when the layout only places built-in-shaped furniture', async () => {
    const harness = await createTestDatabase();
    try {
      await insertCustomAsset(harness, 'UNUSED_CHAIR');
      const layout = { furniture: [{ type: 'SOME_BUILT_IN', col: 0, row: 0 }] };
      expect(await customAssetsForLayout(harness.db, layout)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('returns the referenced custom asset, base64-encoded, with a synthetic furniturePath', async () => {
    const harness = await createTestDatabase();
    try {
      await insertCustomAsset(harness, 'MY_CHAIR');
      const layout = { furniture: [{ type: 'MY_CHAIR', col: 0, row: 0 }] };
      const result = await customAssetsForLayout(harness.db, layout);

      expect(result).toHaveLength(1);
      expect(result[0]?.catalogEntry.id).toBe('MY_CHAIR');
      expect(result[0]?.catalogEntry.furniturePath).toBe('custom-assets/MY_CHAIR.png');
      expect(typeof result[0]?.pngBase64).toBe('string');
      expect(result[0]?.pngBase64.length).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  });

  it('ignores an unrelated custom asset not referenced by the layout', async () => {
    const harness = await createTestDatabase();
    try {
      await insertCustomAsset(harness, 'MY_CHAIR');
      await insertCustomAsset(harness, 'ANOTHER_CHAIR');
      const layout = { furniture: [{ type: 'MY_CHAIR', col: 0, row: 0 }] };
      const result = await customAssetsForLayout(harness.db, layout);
      expect(result.map((r) => r.catalogEntry.id)).toEqual(['MY_CHAIR']);
    } finally {
      await harness.close();
    }
  });

  it('tolerates a malformed layout rather than throwing', async () => {
    const harness = await createTestDatabase();
    try {
      expect(await customAssetsForLayout(harness.db, null)).toEqual([]);
      expect(await customAssetsForLayout(harness.db, 'not an object')).toEqual([]);
      expect(await customAssetsForLayout(harness.db, { furniture: 'not an array' })).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
