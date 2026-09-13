import type {
  CatalogEntry,
  CharacterDirectionSprites,
  PetSpriteFrames,
} from '../../../../vendor/pixel-agents/core/src/assets/types.js';
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

/** The `/:assetId/catalog` response body (#121) — shape mirrors `services/api/src/assets/schemas.ts`'s `singleAssetCatalogResponseSchema`. */
interface SingleAssetCatalog {
  assetKind: 'furniture' | 'character' | 'pet';
  name: string;
  catalog?: CatalogEntry[];
  sprites?: Record<string, string[][]>;
  character?: CharacterDirectionSprites;
  pet?: PetSpriteFrames;
}

async function getJson<T>(base: string, filename: string): Promise<T> {
  const response = await fetch(`${base}/${filename}`);
  if (!response.ok) throw new Error(`Could not load ${filename} (${response.status}).`);
  return (await response.json()) as T;
}

/**
 * The one extra custom asset a single-asset inspection editor (#121) asks
 * for, on top of the built-in bundle every editor loads. Unlike the deleted
 * pre-#120 full-catalog merge, a failure here is NOT swallowed: this
 * editor's entire reason for existing is the one asset it was asked to
 * load, so a failure has to reach the frame's existing error path rather
 * than silently degrading to a built-ins-only editor that looks the same as
 * every other one.
 */
async function loadSingleCustomAsset(assetId: string): Promise<SingleAssetCatalog> {
  const response = await fetch(`${API_BASE_URL}/api/v1/assets/${assetId}/catalog`);
  if (!response.ok) throw new Error(`Could not load asset "${assetId}" (${response.status}).`);
  return (await response.json()) as SingleAssetCatalog;
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
 * #120: built-ins only by default — no custom (uploaded) asset catalog is
 * fetched here for either the read-only layout viewer or the general
 * blank-canvas editor.
 *
 * #121: `assetId`, when given, is the one extra custom asset the single-asset
 * inspection editor asks for — merged in on top of the built-ins, by kind:
 * furniture extends the catalog/sprites pair; character extends the
 * character-template array (its resulting index is returned as
 * `characterPaletteIndex`, so the frame can force its one mock agent onto it
 * instead of a random built-in); pet extends the pet-template array (it then
 * just shows up as one more toggleable entry in "Active pets").
 */
export async function loadLiveOfficeAssets(
  assetId?: string | null,
): Promise<LoadedAssetData & { characterPaletteIndex?: number }> {
  const base = `${import.meta.env.BASE_URL}assets/pixel-agents/${__PIXEL_AGENTS_COMMIT__}`;
  const [characters, floors, walls, carpets, catalog, furniture, petAssets, single] = await Promise.all([
    getJson<CharacterDirectionSprites[]>(base, 'characters.json'),
    getJson<string[][][]>(base, 'floors.json'),
    getJson<string[][][][]>(base, 'walls.json'),
    getJson<string[][][][]>(base, 'carpets.json'),
    getJson<CatalogEntry[]>(base, 'furniture-catalog.json'),
    getJson<Record<string, string[][]>>(base, 'furniture.json'),
    getJson<PetAssets>(base, 'pets.json'),
    assetId ? loadSingleCustomAsset(assetId) : Promise.resolve(null),
  ]);

  let characterPaletteIndex: number | undefined;
  if (single?.assetKind === 'character' && single.character) {
    characterPaletteIndex = characters.length;
    characters.push(single.character);
  } else if (single?.assetKind === 'pet' && single.pet) {
    petAssets.pets.push(single.pet);
    petAssets.names.push(single.name);
  }

  setCharacterTemplates(characters);
  setFloorSprites(floors);
  setWallSprites(walls);
  setCarpetSprites(carpets);
  const loaded: LoadedAssetData = { catalog: [...catalog], sprites: { ...furniture } };
  if (single?.assetKind === 'furniture' && single.catalog && single.sprites) {
    loaded.catalog.push(...single.catalog);
    Object.assign(loaded.sprites, single.sprites);
  }
  if (!buildDynamicCatalog(loaded)) {
    throw new Error('Pixel Agents furniture assets were empty.');
  }
  setPetTemplates(petAssets.pets, petAssets.names);
  return characterPaletteIndex !== undefined ? { ...loaded, characterPaletteIndex } : loaded;
}
