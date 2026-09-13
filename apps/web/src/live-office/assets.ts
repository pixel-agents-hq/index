import type { CatalogEntry, PetSpriteFrames } from '../../../../vendor/pixel-agents/core/src/assets/types.js';
import { setFloorSprites } from '../../../../vendor/pixel-agents/webview-ui/src/office/floorTiles.js';
import type { LoadedAssetData } from '../../../../vendor/pixel-agents/webview-ui/src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../../../../vendor/pixel-agents/webview-ui/src/office/layout/furnitureCatalog.js';
import { setCarpetSprites } from '../../../../vendor/pixel-agents/webview-ui/src/office/sprites/carpetTiles.js';
import { setPetTemplates } from '../../../../vendor/pixel-agents/webview-ui/src/office/sprites/petSpriteData.js';
import { setCharacterTemplates } from '../../../../vendor/pixel-agents/webview-ui/src/office/sprites/spriteData.js';
import { setWallSprites } from '../../../../vendor/pixel-agents/webview-ui/src/office/wallTiles.js';

interface PetAssets {
  pets: PetSpriteFrames[];
  names: string[];
}

async function getJson<T>(base: string, filename: string): Promise<T> {
  const response = await fetch(`${base}/${filename}`);
  if (!response.ok) throw new Error(`Could not load ${filename} (${response.status}).`);
  return (await response.json()) as T;
}

/**
 * Load the same decoded sprite data the real extension sends to its webview.
 *
 * Returns the furniture half of it: upstream's `EditorToolbar` renders its
 * palette from exactly this `{ catalog, sprites }` pair (`LoadedAssetData`),
 * which the extension normally hands the webview over the wire. The sprite
 * setters below are global side effects, so only the editor needs the return
 * value — the read-only viewer ignores it.
 *
 * #120: built-ins only, deliberately — no custom (uploaded) asset catalog is
 * fetched here anymore, for either the read-only layout viewer or the
 * general blank-canvas editor. A future single-asset inspection editor
 * (#121) will load exactly one custom asset through its own, narrower path.
 */
export async function loadLiveOfficeAssets(): Promise<LoadedAssetData> {
  const base = `${import.meta.env.BASE_URL}assets/pixel-agents/${__PIXEL_AGENTS_COMMIT__}`;
  const [characters, floors, walls, carpets, catalog, furniture, petAssets] = await Promise.all([
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
  ]);

  setCharacterTemplates(characters);
  setFloorSprites(floors);
  setWallSprites(walls);
  setCarpetSprites(carpets);
  const loaded: LoadedAssetData = { catalog, sprites: furniture };
  if (!buildDynamicCatalog(loaded)) {
    throw new Error('Pixel Agents furniture assets were empty.');
  }
  setPetTemplates(petAssets.pets, petAssets.names);
  return loaded;
}
