import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestUrl } from '../test/fetchStub';

afterEach(() => vi.unstubAllGlobals());

const CATALOG_ENTRY = {
  id: 'BUILTIN_CHAIR',
  name: 'Chair',
  label: 'Chair',
  category: 'chairs',
  file: 'BUILTIN_CHAIR.png',
  furniturePath: 'furniture/BUILTIN_CHAIR.png',
  width: 16,
  height: 16,
  footprintW: 1,
  footprintH: 1,
  isDesk: false,
  canPlaceOnWalls: false,
};
const SPRITE = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => '#000000'));

function stubStaticBundleFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.endsWith('/assets/catalog')) {
      throw new Error('assets.ts must not fetch the custom-asset catalog by default (#120)');
    }
    if (url.endsWith('characters.json')) return Response.json([]);
    if (url.endsWith('floors.json')) return Response.json([]);
    if (url.endsWith('walls.json')) return Response.json([]);
    if (url.endsWith('carpets.json')) return Response.json([]);
    if (url.endsWith('furniture-catalog.json')) return Response.json([CATALOG_ENTRY]);
    if (url.endsWith('furniture.json')) return Response.json({ BUILTIN_CHAIR: SPRITE });
    if (url.endsWith('pets.json')) return Response.json({ pets: [], names: [] });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe('loadLiveOfficeAssets (#120)', () => {
  it('never requests the custom-asset catalog, and returns only the built-in catalog', async () => {
    const fetchStub = stubStaticBundleFetch();
    vi.stubGlobal('fetch', fetchStub);

    const { loadLiveOfficeAssets } = await import('./assets.js');
    const loaded = await loadLiveOfficeAssets();

    expect(loaded.catalog).toEqual([CATALOG_ENTRY]);
    expect(loaded.sprites).toEqual({ BUILTIN_CHAIR: SPRITE });
    expect(fetchStub.mock.calls.some(([input]) => requestUrl(input).endsWith('/assets/catalog'))).toBe(false);
  });
});
