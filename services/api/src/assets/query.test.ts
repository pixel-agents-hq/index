import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { PIXEL_AGENTS_SYSTEM_USER_ID } from '../db/constants.js';
import * as schema from '../db/schema.js';
import { createTestDatabase, type Harness } from '../db/test-support/harness.js';
import { listCustomAssets } from './query.js';

let harness: Harness;
afterEach(async () => {
  await harness.close();
});

function furnitureRow(
  id: string,
  source: schema.NewCustomAsset['source'],
  extra: Partial<schema.NewCustomAsset> = {},
): schema.NewCustomAsset {
  return {
    assetKind: 'furniture' as const,
    assetId: id,
    requestedAssetId: id,
    name: id,
    category: 'chairs',
    manifest: [
      {
        id,
        name: id,
        label: id,
        category: 'chairs',
        file: `${id}.png`,
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        canPlaceOnWalls: false,
        groupId: id,
      },
    ],
    sprites: { [id]: [['#ff00ff']] },
    rawZip: Buffer.from('fake zip'),
    authorUserId: PIXEL_AGENTS_SYSTEM_USER_ID,
    source,
    ...extra,
  };
}

describe('listCustomAssets pagination', () => {
  // Regression test for the real staging bug: builtinSync.ts bulk-INSERTs
  // every built-in row in one statement, so they all share a single
  // Postgres now() call at genuine microsecond precision. The cursor used
  // to be built from `row.createdAt.toISOString()`, which truncates to
  // millisecond precision -- so the encoded cursor value silently sat
  // *below* the true value shared by every tied row, and none of them
  // satisfied `<` or `=` against it on the next page. In production this
  // meant "Load more" skipped straight past dozens of built-in assets to
  // whatever (unrelated, older) rows happened to sort after them.
  it('does not drop rows that tie exactly at microsecond precision across a page boundary', async () => {
    harness = await createTestDatabase();
    const { db } = harness;

    const builtinRows = Array.from({ length: 33 }, (_, i) =>
      furnitureRow(`BUILTIN_${String(i).padStart(3, '0')}`, 'builtin', { sourceCommit: '0'.repeat(40) }),
    );
    await db.insert(schema.customAssets).values(builtinRows);
    // Hand-crafted microsecond precision: PGlite's own now() is
    // millisecond-aligned, so it can't organically reproduce the precision
    // loss this test targets.
    await db.execute(
      sql`update custom_assets set created_at = '2026-09-11 16:37:11.073456+00' where source = 'builtin'`,
    );

    await db.insert(schema.customAssets).values([
      furnitureRow('CUSTOM_A', 'custom'),
      furnitureRow('CUSTOM_B', 'custom'),
    ]);
    await db.execute(
      sql`update custom_assets set created_at = '2026-09-08 18:58:11.197+00' where source = 'custom'`,
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await listCustomAssets(db, { filters: {}, limit: 24, ...(cursor ? { cursor } : {}) });
      expect(result.total).toBe(35);
      seen.push(...result.rows.map((row) => row.assetId));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    const expected = [...builtinRows.map((row) => row.assetId), 'CUSTOM_A', 'CUSTOM_B'].sort();
    expect([...new Set(seen)].sort()).toEqual(expected);
    expect(seen.length).toBe(expected.length);
  });
});

describe('listCustomAssets tag facet filter', () => {
  it('ORs within a facet and ANDs across the facets present', async () => {
    harness = await createTestDatabase();
    const { db } = harness;

    await db.insert(schema.customAssets).values([
      furnitureRow('FRONT_STATIC', 'custom', { tags: ['front', 'static'] }),
      furnitureRow('BACK_STATIC', 'custom', { tags: ['back', 'static'] }),
      furnitureRow('SIDE_ANIMATED', 'custom', { tags: ['side', 'animated'] }),
      furnitureRow('FRONT_ANIMATED_INTERACTABLE', 'custom', {
        tags: ['front', 'static', 'animated', 'interactable'],
      }),
    ]);

    // OR within the orientation facet: front OR back, regardless of animation status.
    const orientation = await listCustomAssets(db, {
      filters: { orientation: ['front', 'back'] },
      limit: 24,
    });
    expect(orientation.rows.map((r) => r.assetId).sort()).toEqual(
      ['FRONT_STATIC', 'BACK_STATIC', 'FRONT_ANIMATED_INTERACTABLE'].sort(),
    );

    // AND across facets: front (orientation) AND animated (animation status)
    // — narrows further than either facet alone, not an OR of the two.
    const combined = await listCustomAssets(db, {
      filters: { orientation: ['front'], animation: ['animated'] },
      limit: 24,
    });
    expect(combined.rows.map((r) => r.assetId)).toEqual(['FRONT_ANIMATED_INTERACTABLE']);

    // interactable: true only matches the one asset carrying that tag.
    const interactable = await listCustomAssets(db, { filters: { interactable: true }, limit: 24 });
    expect(interactable.rows.map((r) => r.assetId)).toEqual(['FRONT_ANIMATED_INTERACTABLE']);

    // interactable: false is every asset lacking the tag.
    const notInteractable = await listCustomAssets(db, { filters: { interactable: false }, limit: 24 });
    expect(notInteractable.rows.map((r) => r.assetId).sort()).toEqual(
      ['FRONT_STATIC', 'BACK_STATIC', 'SIDE_ANIMATED'].sort(),
    );
  });
});
