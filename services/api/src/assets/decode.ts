/**
 * Turns an uploaded custom-furniture zip into what `custom_assets` stores:
 * the assigned id, the flattened `CatalogEntry`-shaped manifest, and decoded
 * sprite data per variant.
 *
 * Accepts the exact zip shape pixel-art-mcp's own `pixel_agents` export
 * option already produces (`docs/external-assets.md`,
 * `assets/furniture/<ASSET_ID>/{manifest.json, *.png}`) — a manifest.json
 * anywhere in the zip, PNGs alongside it, resolved relative to its own
 * directory. No translation layer between what pixel-art-mcp ships and what
 * this accepts, by design (issue #101).
 *
 * The zip/PNG plumbing this shares with `decodeCharacter.ts`/`decodePet.ts`
 * lives in `zip.ts` (#105) — this module keeps only what's furniture-specific:
 * manifest-tree flattening and the category-driven `isDesk` derivation.
 */

import JSZip from 'jszip';

import { ApiError } from '../errors.js';
import {
  ASSET_ID_RE,
  type FlattenedAsset,
  flattenManifest,
  type FurnitureManifest,
  type ManifestGroup,
  type ManifestNode,
  validateManifestShape,
} from './manifest.js';
import { decodePng, findNamedTextEntry, firstFreeId, type IdCollisionChecker, issue } from './zip.js';

export interface DecodedFurnitureAsset {
  assetKind: 'furniture';
  /** The id actually assigned — may differ from the manifest's own if it collided. */
  assetId: string;
  requestedAssetId: string;
  name: string;
  category: string;
  /** One entry per flattened variant, `id` rewritten to the assigned root id's namespace. */
  manifest: FlattenedAsset[];
  sprites: Record<string, string[][]>;
}

function rootNode(manifest: FurnitureManifest): ManifestNode {
  return manifest.type === 'asset'
    ? {
        type: 'asset',
        id: manifest.id,
        file: manifest.file ?? '',
        width: manifest.width ?? 0,
        height: manifest.height ?? 0,
        footprintW: manifest.footprintW ?? 0,
        footprintH: manifest.footprintH ?? 0,
      }
    : {
        type: 'group',
        groupType: (manifest.groupType as ManifestGroup['groupType'] | undefined) ?? 'rotation',
        ...(manifest.rotationScheme ? { rotationScheme: manifest.rotationScheme } : {}),
        members: manifest.members ?? [],
      };
}

/**
 * Renames every leaf's id and `groupId`/`animationGroup` prefix from
 * `fromRoot` to `toRoot` — the mechanical part of "the whole group moved to a
 * suffixed id", so `MY_CHAIR_FRONT`/`MY_CHAIR_SIDE` become
 * `MY_CHAIR_2_FRONT`/`MY_CHAIR_2_SIDE` together, not just the root.
 */
function rewriteIds(assets: FlattenedAsset[], fromRoot: string, toRoot: string): FlattenedAsset[] {
  if (fromRoot === toRoot) return assets;
  const rename = (value: string) => (value.startsWith(fromRoot) ? toRoot + value.slice(fromRoot.length) : value);
  return assets.map((asset) => ({
    ...asset,
    id: rename(asset.id),
    groupId: rename(asset.groupId),
    ...(asset.animationGroup ? { animationGroup: rename(asset.animationGroup) } : {}),
  }));
}

export async function decodeFurnitureZip(
  zipBuffer: Buffer,
  name: string,
  category: string,
  isIdTaken: IdCollisionChecker,
): Promise<DecodedFurnitureAsset> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch {
    throw issue('/', 'Could not be read as a zip archive.');
  }

  const found = await findNamedTextEntry(zip, 'manifest.json');
  if (!found) throw issue('/', 'The zip does not contain a manifest.json.');
  const { dir, text } = found;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw issue('/manifest.json', 'manifest.json is not valid JSON.');
  }

  const validated = validateManifestShape(parsed);
  if ('issues' in validated) {
    throw ApiError.validation(
      validated.issues.map((i) => ({ code: 'meta.schema' as const, path: i.path, message: i.message })),
      'Invalid manifest.json.',
    );
  }
  const { manifest } = validated;

  const requestedAssetId = manifest.id;
  // Only the group's root id is checked/suffixed for collisions — that's the
  // one that's public and URL-addressed. A suffixed group's own derived
  // member ids (MY_CHAIR_2_FRONT, ...) are not independently re-checked
  // against every other asset's variant ids; the practical collision risk
  // there is low, and there is no cheap index to check it against today.
  const assignedRootId = firstFreeId(requestedAssetId, isIdTaken);

  const inherited = {
    groupId: manifest.id,
    name: manifest.name,
    category: manifest.category,
    canPlaceOnWalls: manifest.canPlaceOnWalls ?? false,
    canPlaceOnSurfaces: manifest.canPlaceOnSurfaces ?? false,
    backgroundTiles: manifest.backgroundTiles ?? 0,
    ...(manifest.rotationScheme ? { rotationScheme: manifest.rotationScheme } : {}),
  };
  const flattened = flattenManifest(rootNode(manifest), inherited);
  if (flattened.length === 0) {
    throw issue('/', 'The manifest produced no placeable variants.');
  }

  const renamed = rewriteIds(flattened, requestedAssetId, assignedRootId);

  const sprites: Record<string, string[][]> = {};
  for (const asset of renamed) {
    const zipPath = `${dir}${asset.file}`;
    const entry = zip.file(zipPath);
    if (!entry) throw issue('/', `Referenced file "${asset.file}" was not found in the zip.`);
    if (!ASSET_ID_RE.test(asset.id)) {
      throw issue('/', `Variant id "${asset.id}" is not valid (A-Z, 0-9, underscore, starting with a letter).`);
    }
    const buffer = await entry.async('nodebuffer');
    sprites[asset.id] = decodePng(buffer, asset.width, asset.height, `/${asset.file}`);
  }

  return {
    assetKind: 'furniture',
    assetId: assignedRootId,
    requestedAssetId,
    name,
    category,
    manifest: renamed,
    sprites,
  };
}
