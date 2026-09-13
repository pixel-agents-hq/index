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

const CUSTOM_CATALOG_ENTRY = { ...CATALOG_ENTRY, id: 'CUSTOM_LAMP', file: 'CUSTOM_LAMP.png' };
const CUSTOM_SPRITE = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => '#ff00ff'));
const CHARACTER_FRAMES = { down: [SPRITE], up: [SPRITE], right: [SPRITE] };
const PET_FRAMES = {
  walkDown: [SPRITE, SPRITE, SPRITE],
  idleDown: [SPRITE, SPRITE, SPRITE],
  walkUp: [SPRITE, SPRITE, SPRITE],
  idleUp: [SPRITE, SPRITE, SPRITE],
  walkRight: [SPRITE, SPRITE, SPRITE],
};

/** `single`, when given, stubs `GET /api/v1/assets/:assetId/catalog`'s response body — the #121 single-asset route. */
function stubStaticBundleFetch(single?: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.endsWith('/assets/catalog')) {
      throw new Error('assets.ts must not fetch the full custom-asset catalog by default (#120)');
    }
    if (/\/assets\/[^/]+\/catalog$/.test(url)) {
      if (!single) throw new Error(`unexpected single-asset fetch: ${url}`);
      return Response.json(single);
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
    expect(loaded.characterPaletteIndex).toBeUndefined();
    expect(fetchStub.mock.calls.some(([input]) => requestUrl(input).endsWith('/assets/catalog'))).toBe(false);
  });

  it('still never requests any single-asset catalog when no id is given', async () => {
    const fetchStub = stubStaticBundleFetch();
    vi.stubGlobal('fetch', fetchStub);

    const { loadLiveOfficeAssets } = await import('./assets.js');
    await loadLiveOfficeAssets(null);

    expect(fetchStub.mock.calls.some(([input]) => /\/assets\/[^/]+\/catalog$/.test(requestUrl(input)))).toBe(
      false,
    );
  });
});

describe('loadLiveOfficeAssets(assetId) (#121)', () => {
  it('merges one extra furniture asset into the built-in catalog + sprites', async () => {
    const fetchStub = stubStaticBundleFetch({
      assetKind: 'furniture',
      name: 'Custom Lamp',
      catalog: [CUSTOM_CATALOG_ENTRY],
      sprites: { CUSTOM_LAMP: CUSTOM_SPRITE },
    });
    vi.stubGlobal('fetch', fetchStub);

    const { loadLiveOfficeAssets } = await import('./assets.js');
    const loaded = await loadLiveOfficeAssets('CUSTOM_LAMP');

    expect(loaded.catalog.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['BUILTIN_CHAIR', 'CUSTOM_LAMP']),
    );
    expect(loaded.sprites.CUSTOM_LAMP).toEqual(CUSTOM_SPRITE);
    expect(loaded.characterPaletteIndex).toBeUndefined();
    expect(
      fetchStub.mock.calls.some(([input]) => requestUrl(input).endsWith('/assets/CUSTOM_LAMP/catalog')),
    ).toBe(true);
  });

  it('appends one extra character and returns its palette index', async () => {
    const fetchStub = stubStaticBundleFetch({
      assetKind: 'character',
      name: 'Custom Hero',
      character: CHARACTER_FRAMES,
    });
    vi.stubGlobal('fetch', fetchStub);

    const { loadLiveOfficeAssets } = await import('./assets.js');
    const { getLoadedCharacterCount } = await import(
      '../../../../vendor/pixel-agents/webview-ui/src/office/sprites/spriteData.js'
    );
    const loaded = await loadLiveOfficeAssets('CUSTOM_HERO');

    // The stub's characters.json is empty, so the one appended custom
    // character is the only (and therefore 0th) loaded character.
    expect(loaded.characterPaletteIndex).toBe(0);
    expect(getLoadedCharacterCount()).toBe(1);
  });

  it('appends one extra pet, with no palette index (pets have their own toggle, not a mock agent)', async () => {
    const fetchStub = stubStaticBundleFetch({
      assetKind: 'pet',
      name: 'Custom Pet',
      pet: PET_FRAMES,
    });
    vi.stubGlobal('fetch', fetchStub);

    const { loadLiveOfficeAssets } = await import('./assets.js');
    const { getPetCount } = await import(
      '../../../../vendor/pixel-agents/webview-ui/src/office/sprites/petSpriteData.js'
    );
    const loaded = await loadLiveOfficeAssets('CUSTOM_PET');

    expect(loaded.characterPaletteIndex).toBeUndefined();
    expect(getPetCount()).toBe(1);
  });

  it('propagates a failure to load the requested asset rather than degrading to built-ins-only', async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (/\/assets\/[^/]+\/catalog$/.test(url)) return new Response('not found', { status: 404 });
      return stubStaticBundleFetch()(input);
    });
    vi.stubGlobal('fetch', fetchStub);

    const { loadLiveOfficeAssets } = await import('./assets.js');
    await expect(loadLiveOfficeAssets('MISSING')).rejects.toThrow();
  });
});
