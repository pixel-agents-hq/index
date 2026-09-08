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
 */

import JSZip from 'jszip';
import { PNG } from 'pngjs';

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

export interface DecodedAsset {
  /** The id actually assigned — may differ from the manifest's own if it collided. */
  assetId: string;
  requestedAssetId: string;
  name: string;
  category: string;
  /** One entry per flattened variant, `id` rewritten to the assigned root id's namespace. */
  manifest: FlattenedAsset[];
  sprites: Record<string, string[][]>;
}

/** Checks a candidate id (and everywhere it appears in a manifest tree) for uniqueness. */
export type IdCollisionChecker = (id: string) => boolean;

function issue(path: string, message: string): ApiError {
  return ApiError.validation([{ code: 'meta.schema', path, message }], 'Invalid custom asset upload.');
}

/**
 * Strict `pngToSpriteData`: rejects a PNG whose actual dimensions don't match
 * the manifest's declared `width`/`height`, rather than upstream's own
 * silent-warn-and-misread-the-buffer behavior (`core/src/assets/pngDecoder.ts`)
 * — the right default for a bundled, trusted asset pack is not the right
 * default for an untrusted upload.
 */
function decodePng(buffer: Buffer, width: number, height: number, path: string): string[][] {
  let png: PNG;
  try {
    png = PNG.sync.read(buffer);
  } catch {
    throw issue(path, 'Could not be parsed as a PNG.');
  }
  if (png.width !== width || png.height !== height) {
    throw issue(
      path,
      `Declared ${width}×${height} but the PNG is actually ${png.width}×${png.height}.`,
    );
  }

  const sprite: string[][] = [];
  for (let y = 0; y < height; y++) {
    const row: string[] = [];
    for (let x = 0; x < width; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i];
      const g = png.data[i + 1];
      const b = png.data[i + 2];
      const a = png.data[i + 3];
      row.push(a === undefined || a < 2 ? '' : toHex(r ?? 0, g ?? 0, b ?? 0, a));
    }
    sprite.push(row);
  }
  return sprite;
}

function toHex(r: number, g: number, b: number, a: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return a < 255 ? `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}` : `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Suffixes `_2`, `_3`, ... onto `id` until `isTaken` says no one holds it. */
function firstFreeId(id: string, isTaken: IdCollisionChecker): string {
  if (!isTaken(id)) return id;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${id}_${n}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new ApiError(500, 'internal_error', 'Could not find a free asset id.');
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

/**
 * Finds `manifest.json` anywhere in the zip and resolves PNG paths relative
 * to its directory — handles both pixel-art-mcp's nested
 * `assets/furniture/<ID>/manifest.json` shape and a flat root-level upload.
 */
async function findManifestEntry(zip: JSZip): Promise<{ dir: string; text: string }> {
  const candidates = Object.keys(zip.files).filter((name) => name.split('/').pop() === 'manifest.json');
  if (candidates.length === 0) {
    throw issue('/', 'The zip does not contain a manifest.json.');
  }
  if (candidates.length > 1) {
    throw issue('/', 'The zip must contain exactly one manifest.json.');
  }
  const path = candidates[0];
  if (path === undefined) throw issue('/', 'The zip does not contain a manifest.json.');
  const entry = zip.file(path);
  if (!entry) throw issue('/', 'The zip does not contain a manifest.json.');
  const text = await entry.async('text');
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  return { dir, text };
}

export async function decodeAssetZip(
  zipBuffer: Buffer,
  name: string,
  category: string,
  isIdTaken: IdCollisionChecker,
): Promise<DecodedAsset> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch {
    throw issue('/', 'Could not be read as a zip archive.');
  }

  const { dir, text } = await findManifestEntry(zip);

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
    assetId: assignedRootId,
    requestedAssetId,
    name,
    category,
    manifest: renamed,
    sprites,
  };
}
