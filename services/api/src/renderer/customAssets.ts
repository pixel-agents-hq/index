/**
 * Which custom (uploaded) assets a render request needs, packaged for the
 * renderer (#101 stage 4 furniture, #105 characters + pets).
 *
 * The renderer has no database of its own (confirmed: `services/renderer`
 * imports nothing DB-related) — it can only render what this service embeds
 * directly in the render request. This is the one place that does that
 * embedding, shared by every route that asks the renderer for a preview
 * (submit, preview-check, replace, and the slug-addressed preview/thumbnail
 * routes).
 *
 * Furniture is filtered to what the layout actually places, the same as
 * before #105. Characters and pets have no such filter to apply: a character
 * is never referenced by a layout's JSON at all (upstream picks one
 * positionally, outside the layout), and a custom pet's `petType` index is a
 * pixel-index-assigned ordering (there is no bundled pet to reconcile
 * against — see `render.ts`), not something worth threading through a
 * layout-shape guess. Every published character/pet is sent on every render
 * that has any; the renderer decides what a given layout actually uses.
 */

import type { CharacterFrames } from '../assets/decodeCharacter.js';
import type { PetFrames } from '../assets/decodePet.js';
import type { FlattenedAsset } from '../assets/manifest.js';
import { allCustomAssetCatalog, customAssetsOfKind } from '../assets/query.js';
import { encodeSpritePng } from '../assets/spritePng.js';
import type { AnyDatabase } from '../db/client.js';

export type RenderCustomAsset =
  | {
      kind: 'furniture';
      /** `CatalogEntry`-shaped, plus a synthetic `furniturePath` the renderer's route interception serves the PNG at. */
      catalogEntry: FlattenedAsset & { furniturePath: string };
      pngBase64: string;
    }
  | { kind: 'character'; sprites: CharacterFrames }
  | { kind: 'pet'; name: string; frames: PetFrames };

function furnitureTypesUsed(layout: unknown): Set<string> {
  const types = new Set<string>();
  if (!layout || typeof layout !== 'object') return types;
  const furniture = (layout as { furniture?: unknown }).furniture;
  if (!Array.isArray(furniture)) return types;
  for (const item of furniture) {
    if (item && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string') {
      types.add((item as { type: string }).type);
    }
  }
  return types;
}

/**
 * Every custom furniture variant `layout` places, decoded back into a real
 * PNG (`encodeSpritePng` — the reverse of the decode `assets/decode.ts` did
 * at upload time) and base64-encoded for the JSON request body.
 *
 * Reads every published custom furniture asset (`allCustomAssetCatalog`)
 * rather than a targeted lookup by id — there is no index over the manifest
 * variants' individual ids today, and at the scale a community furniture
 * catalog actually reaches, filtering the whole (small) set in memory is
 * simpler than adding one speculatively.
 */
async function furnitureForLayout(db: AnyDatabase, layout: unknown): Promise<RenderCustomAsset[]> {
  const used = furnitureTypesUsed(layout);
  if (used.size === 0) return [];

  const { catalog, sprites } = await allCustomAssetCatalog(db);
  const result: RenderCustomAsset[] = [];
  for (const entry of catalog as FlattenedAsset[]) {
    if (!used.has(entry.id)) continue;
    const sprite = sprites[entry.id];
    if (!sprite) continue;
    result.push({
      kind: 'furniture',
      catalogEntry: { ...entry, furniturePath: `custom-assets/${entry.id}.png` },
      pngBase64: encodeSpritePng(sprite).toString('base64'),
    });
  }
  return result;
}

/** Every published custom character, oldest first — a stable order across renders (and across two pins in the CI gate). */
async function allCharacters(db: AnyDatabase): Promise<RenderCustomAsset[]> {
  const rows = await customAssetsOfKind(db, 'character');
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.assetId.localeCompare(b.assetId));
  return rows.map((row) => {
    const manifest = row.manifest as [{ id: string }];
    const sprites = row.sprites as Record<string, CharacterFrames>;
    return { kind: 'character', sprites: sprites[manifest[0].id] as CharacterFrames };
  });
}

/** Every published custom pet, oldest first — same stability reasoning as `allCharacters`. */
async function allPets(db: AnyDatabase): Promise<RenderCustomAsset[]> {
  const rows = await customAssetsOfKind(db, 'pet');
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.assetId.localeCompare(b.assetId));
  return rows.map((row) => {
    const manifest = row.manifest as [{ id: string }];
    const sprites = row.sprites as Record<string, PetFrames>;
    return { kind: 'pet', name: row.name, frames: sprites[manifest[0].id] as PetFrames };
  });
}

/**
 * The `CatalogEntry`-shaped subset of a `RenderCustomAsset[]` — what
 * `mergeFurnitureCatalog` (`@pixel-index/layout-core`) needs to let a layout
 * validate against custom furniture. Every route that validates a layout
 * against `customAssetsForLayout`'s result needs this same filter (#105):
 * a character or pet entry has no `catalogEntry` to merge in.
 */
export function furnitureCatalogEntries(assets: RenderCustomAsset[]): FlattenedAsset[] {
  return assets
    .filter((asset): asset is Extract<RenderCustomAsset, { kind: 'furniture' }> => asset.kind === 'furniture')
    .map((asset) => asset.catalogEntry);
}

export async function customAssetsForLayout(db: AnyDatabase, layout: unknown): Promise<RenderCustomAsset[]> {
  const [furniture, characters, pets] = await Promise.all([
    furnitureForLayout(db, layout),
    allCharacters(db),
    allPets(db),
  ]);
  return [...furniture, ...characters, ...pets];
}
