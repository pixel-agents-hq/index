/**
 * Which custom (uploaded) furniture a layout actually places, packaged for
 * the renderer (#101 stage 4).
 *
 * The renderer has no database of its own (confirmed: `services/renderer`
 * imports nothing DB-related) — it can only render what this service embeds
 * directly in the render request. This is the one place that does that
 * embedding, shared by every route that asks the renderer for a preview
 * (submit, preview-check, replace, and the slug-addressed preview/thumbnail
 * routes).
 */

import type { FlattenedAsset } from '../assets/manifest.js';
import { allCustomAssetCatalog } from '../assets/query.js';
import { encodeSpritePng } from '../assets/spritePng.js';
import type { AnyDatabase } from '../db/client.js';

export interface RenderCustomAsset {
  /** `CatalogEntry`-shaped, plus a synthetic `furniturePath` the renderer's route interception serves the PNG at. */
  catalogEntry: FlattenedAsset & { furniturePath: string };
  pngBase64: string;
}

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
 * Reads every published custom asset (`allCustomAssetCatalog`) rather than a
 * targeted lookup by id — there is no index over the manifest variants'
 * individual ids today, and at the scale a community furniture catalog
 * actually reaches, filtering the whole (small) set in memory is simpler
 * than adding one speculatively.
 */
export async function customAssetsForLayout(
  db: AnyDatabase,
  layout: unknown,
): Promise<RenderCustomAsset[]> {
  const used = furnitureTypesUsed(layout);
  if (used.size === 0) return [];

  const { catalog, sprites } = await allCustomAssetCatalog(db);
  const result: RenderCustomAsset[] = [];
  for (const entry of catalog as FlattenedAsset[]) {
    if (!used.has(entry.id)) continue;
    const sprite = sprites[entry.id];
    if (!sprite) continue;
    result.push({
      catalogEntry: { ...entry, furniturePath: `custom-assets/${entry.id}.png` },
      pngBase64: encodeSpritePng(sprite).toString('base64'),
    });
  }
  return result;
}
