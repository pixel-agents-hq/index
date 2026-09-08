import type { CatalogEntry, PetSpriteFrames } from '../../../../vendor/pixel-agents/core/src/assets/types.js';
import { setFloorSprites } from '../../../../vendor/pixel-agents/webview-ui/src/office/floorTiles.js';
import type { LoadedAssetData } from '../../../../vendor/pixel-agents/webview-ui/src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../../../../vendor/pixel-agents/webview-ui/src/office/layout/furnitureCatalog.js';
import { setCarpetSprites } from '../../../../vendor/pixel-agents/webview-ui/src/office/sprites/carpetTiles.js';
import { setPetTemplates } from '../../../../vendor/pixel-agents/webview-ui/src/office/sprites/petSpriteData.js';
import { setCharacterTemplates } from '../../../../vendor/pixel-agents/webview-ui/src/office/sprites/spriteData.js';
import { setWallSprites } from '../../../../vendor/pixel-agents/webview-ui/src/office/wallTiles.js';
import { API_BASE_URL } from '../api/client';

interface PetAssets {
  pets: PetSpriteFrames[];
  names: string[];
}

async function getJson<T>(base: string, filename: string): Promise<T> {
  const response = await fetch(`${base}/${filename}`);
  if (!response.ok) throw new Error(`Could not load ${filename} (${response.status}).`);
  return (await response.json()) as T;
}

interface CustomAssetCatalog {
  catalog: CatalogEntry[];
  sprites: Record<string, string[][]>;
}

/**
 * Every published custom asset (#101), merged into the bundled catalog below
 * before `buildDynamicCatalog()` ever runs. Calling that function a second
 * time — once per source — was considered and rejected: it REPLACES its
 * internal state rather than accumulating (confirmed by reading
 * `furnitureCatalog.ts`'s own body: `dynamicCatalog = visibleEntries` is a
 * straight reassignment, and its rotation/state/animation `Map`s are
 * `.clear()`d at the top of every call), so a second call would silently
 * make the bundled catalog disappear rather than add to it.
 *
 * A failure here degrades to "no custom assets today," not "no office at
 * all" — a self-hoster's API being briefly unreachable must not break the
 * built-in furniture catalog every viewer depends on.
 */
async function loadCustomAssetCatalog(): Promise<CustomAssetCatalog> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/assets/catalog`);
    if (!response.ok) throw new Error(`unexpected status ${response.status}`);
    const body = (await response.json()) as CustomAssetCatalog;
    return { catalog: body.catalog, sprites: body.sprites };
  } catch (error) {
    console.warn('[live-office] Could not load custom assets; continuing with built-ins only.', error);
    return { catalog: [], sprites: {} };
  }
}

/**
 * Load the same decoded sprite data the real extension sends to its webview.
 *
 * Returns the furniture half of it: upstream's `EditorToolbar` renders its
 * palette from exactly this `{ catalog, sprites }` pair (`LoadedAssetData`),
 * which the extension normally hands the webview over the wire. The sprite
 * setters below are global side effects, so only the editor needs the return
 * value — the read-only viewer ignores it.
 */
export async function loadLiveOfficeAssets(): Promise<LoadedAssetData> {
  const base = `${import.meta.env.BASE_URL}assets/pixel-agents/${__PIXEL_AGENTS_COMMIT__}`;
  const [characters, floors, walls, carpets, catalog, furniture, petAssets, customAssets] = await Promise.all([
    getJson<{ down: string[][][]; up: string[][][]; right: string[][][] }[]>(
      base,
      'characters.json',
    ),
    getJson<string[][][]>(base, 'floors.json'),
    getJson<string[][][][]>(base, 'walls.json'),
    getJson<string[][][][]>(base, 'carpets.json'),
    getJson<CatalogEntry[]>(base, 'furniture-catalog.json'),
    getJson<Record<string, string[][]>>(base, 'furniture.json'),
    getJson<PetAssets>(base, 'pets.json'),
    loadCustomAssetCatalog(),
  ]);

  setCharacterTemplates(characters);
  setFloorSprites(floors);
  setWallSprites(walls);
  setCarpetSprites(carpets);
  const loaded: LoadedAssetData = {
    catalog: [...catalog, ...customAssets.catalog],
    sprites: { ...furniture, ...customAssets.sprites },
  };
  if (!buildDynamicCatalog(loaded)) {
    throw new Error('Pixel Agents furniture assets were empty.');
  }
  setPetTemplates(petAssets.pets, petAssets.names);
  return loaded;
}
