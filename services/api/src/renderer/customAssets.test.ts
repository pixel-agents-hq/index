import { describe, expect, it } from 'vitest';

import * as schema from '../db/schema.js';
import { createTestDatabase, type Harness } from '../db/test-support/harness.js';
import { insertUser } from '../test-support/layouts.js';
import { customAssetsForLayout } from './customAssets.js';

async function insertFurniture(harness: Harness, assetId: string) {
  const user = await insertUser(harness.db, { username: `author-of-${assetId}` });
  await harness.db.insert(schema.customAssets).values({
    assetKind: 'furniture',
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

function grid16() {
  return Array.from({ length: 32 }, () => Array.from({ length: 16 }, () => '#00ff00'));
}
function grid32() {
  return Array.from({ length: 32 }, () => Array.from({ length: 32 }, () => '#00ff00'));
}

async function insertCharacter(harness: Harness, assetId: string) {
  const user = await insertUser(harness.db, { username: `author-of-${assetId}` });
  await harness.db.insert(schema.customAssets).values({
    assetKind: 'character',
    assetId,
    requestedAssetId: assetId,
    name: assetId,
    category: null,
    manifest: [{ id: assetId, name: assetId, label: assetId, width: 112, height: 96 }],
    sprites: {
      [assetId]: {
        down: [grid16(), grid16(), grid16(), grid16(), grid16(), grid16(), grid16()],
        up: [grid16(), grid16(), grid16(), grid16(), grid16(), grid16(), grid16()],
        right: [grid16(), grid16(), grid16(), grid16(), grid16(), grid16(), grid16()],
      },
    },
    rawZip: Buffer.from('fake zip'),
    authorUserId: user.id,
  });
}

async function insertPet(harness: Harness, assetId: string, name: string) {
  const user = await insertUser(harness.db, { username: `author-of-${assetId}` });
  await harness.db.insert(schema.customAssets).values({
    assetKind: 'pet',
    assetId,
    requestedAssetId: assetId,
    name,
    category: null,
    manifest: [{ id: assetId, name, width: 96, height: 96 }],
    sprites: {
      [assetId]: {
        walkDown: [grid16(), grid16(), grid16()],
        idleDown: [grid16(), grid16(), grid16()],
        walkUp: [grid16(), grid16(), grid16()],
        idleUp: [grid16(), grid16(), grid16()],
        walkRight: [grid32(), grid32(), grid32()],
      },
    },
    rawZip: Buffer.from('fake zip'),
    authorUserId: user.id,
  });
}

describe('customAssetsForLayout', () => {
  it('returns nothing for a layout with no furniture and no published characters/pets', async () => {
    const harness = await createTestDatabase();
    try {
      const result = await customAssetsForLayout(harness.db, { version: 1, cols: 1, rows: 1, tiles: [0], furniture: [] });
      expect(result).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('returns nothing when the layout only places built-in-shaped furniture', async () => {
    const harness = await createTestDatabase();
    try {
      await insertFurniture(harness, 'UNUSED_CHAIR');
      const layout = { furniture: [{ type: 'SOME_BUILT_IN', col: 0, row: 0 }] };
      expect(await customAssetsForLayout(harness.db, layout)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('returns the referenced custom furniture, base64-encoded, with a synthetic furniturePath', async () => {
    const harness = await createTestDatabase();
    try {
      await insertFurniture(harness, 'MY_CHAIR');
      const layout = { furniture: [{ type: 'MY_CHAIR', col: 0, row: 0 }] };
      const result = await customAssetsForLayout(harness.db, layout);

      expect(result).toHaveLength(1);
      const asset = result[0];
      if (asset?.kind !== 'furniture') throw new Error('expected a furniture asset');
      expect(asset.catalogEntry.id).toBe('MY_CHAIR');
      expect(asset.catalogEntry.furniturePath).toBe('custom-assets/MY_CHAIR.png');
      expect(typeof asset.pngBase64).toBe('string');
      expect(asset.pngBase64.length).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  });

  it('ignores an unrelated custom furniture asset not referenced by the layout', async () => {
    const harness = await createTestDatabase();
    try {
      await insertFurniture(harness, 'MY_CHAIR');
      await insertFurniture(harness, 'ANOTHER_CHAIR');
      const layout = { furniture: [{ type: 'MY_CHAIR', col: 0, row: 0 }] };
      const result = await customAssetsForLayout(harness.db, layout);
      const furnitureIds = result
        .filter((r) => r.kind === 'furniture')
        .map((r) => r.catalogEntry.id);
      expect(furnitureIds).toEqual(['MY_CHAIR']);
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

  it('includes every published character regardless of what the layout places (#105)', async () => {
    const harness = await createTestDatabase();
    try {
      await insertCharacter(harness, 'MY_CHARACTER');
      const result = await customAssetsForLayout(harness.db, { furniture: [] });
      expect(result).toHaveLength(1);
      expect(result[0]?.kind).toBe('character');
    } finally {
      await harness.close();
    }
  });

  it('includes every published pet, carrying its display name (#105)', async () => {
    const harness = await createTestDatabase();
    try {
      await insertPet(harness, 'MY_PET', 'Bubbles');
      const result = await customAssetsForLayout(harness.db, { furniture: [] });
      expect(result).toHaveLength(1);
      const asset = result[0];
      if (asset?.kind !== 'pet') throw new Error('expected a pet asset');
      expect(asset.name).toBe('Bubbles');
      expect(asset.frames.walkRight).toHaveLength(3);
    } finally {
      await harness.close();
    }
  });

  it('combines layout-referenced furniture with every published character and pet', async () => {
    const harness = await createTestDatabase();
    try {
      await insertFurniture(harness, 'MY_CHAIR');
      await insertCharacter(harness, 'MY_CHARACTER');
      await insertPet(harness, 'MY_PET', 'Bubbles');
      const layout = { furniture: [{ type: 'MY_CHAIR', col: 0, row: 0 }] };
      const result = await customAssetsForLayout(harness.db, layout);
      expect(result.map((r) => r.kind).sort()).toEqual(['character', 'furniture', 'pet']);
    } finally {
      await harness.close();
    }
  });
});
