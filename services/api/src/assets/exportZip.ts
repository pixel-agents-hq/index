/**
 * Builds a zip a user can drop straight into a pixel-agents
 * `externalAssetDirectories` entry (#119) — the single shared builder behind
 * both `GET /api/v1/assets/:assetId/download` and
 * `GET /api/v1/assets/download?ids=...` (routes.ts), so "download one" is
 * just "download a selection of one".
 *
 * pixel-agents' own external-asset loader (`~/pixel-agents`,
 * `server/src/assetLoader.ts`, `docs/external-assets.md` — verified against
 * that repo directly, read-only reference) requires a strict, fixed layout
 * that does NOT match what `custom_assets.rawZip` stores (that column is the
 * *upload* format, which accepts either a flat or nested layout — see
 * `docs/custom-asset-zip-contract.md`). So this regenerates every file from
 * the DB's decoded `manifest`/`sprites` columns instead of repackaging
 * `rawZip` (owner decision, #119):
 *
 *   assets/furniture/<assetId>/manifest.json + <leafId>.png per variant
 *   assets/pets/<assetId>/manifest.json + pet.png
 *   assets/characters/char_N.png            (flat, sequential, no manifest —
 *                                             pixel-agents has no id/name
 *                                             concept for external characters
 *                                             at all, so one is not written)
 *
 * Furniture is the interesting case: `custom_assets.manifest` stores the
 * *flattened* leaves (`FlattenedAsset[]`, one per rotation/state/animation
 * variant — the original nested manifest tree an uploader wrote is not kept
 * anywhere), but pixel-agents' loader needs the *nested* `FurnitureManifest`
 * shape back (`manifest.ts`'s `ManifestAsset`/`ManifestGroup`). This
 * reconstructs one by grouping leaves first by `rotationScheme`, then by
 * `animationGroup` — the two fields that can only be reproduced by an
 * ancestor `ManifestGroup` (they have no leaf-level equivalent in
 * `ManifestAsset`), everything else (`orientation`/`state`/`mirrorSide`/
 * `frame`) is stamped directly on each leaf, which `flattenManifest` always
 * prefers over anything inherited. This targets what this system's own
 * upload/flatten pipeline actually produces (a root-level rotation group of
 * flat leaves, or a single plain asset — the only shapes
 * `decode.test.ts`/`customAssetContract.test.ts` exercise today) while still
 * handling `animation`-groupType assets correctly, since the manifest schema
 * allows them even though no current fixture uses one.
 */

import JSZip from 'jszip';

import type * as schema from '../db/schema.js';
import { type CharacterFrames,encodeCharacterSheet } from './decodeCharacter.js';
import { encodePetSheet, type PetFrames } from './decodePet.js';
import type { FlattenedAsset, FurnitureManifest, ManifestAsset, ManifestGroup, ManifestNode } from './manifest.js';
import { encodeSpritePng } from './spritePng.js';

function fileNameFor(leaf: FlattenedAsset): string {
  return `${leaf.id}.png`;
}

function leafToAssetNode(leaf: FlattenedAsset): ManifestAsset {
  return {
    type: 'asset',
    id: leaf.id,
    file: fileNameFor(leaf),
    width: leaf.width,
    height: leaf.height,
    footprintW: leaf.footprintW,
    footprintH: leaf.footprintH,
    ...(leaf.orientation ? { orientation: leaf.orientation } : {}),
    ...(leaf.state ? { state: leaf.state } : {}),
    ...(leaf.mirrorSide ? { mirrorSide: true } : {}),
    ...(leaf.frame !== undefined ? { frame: leaf.frame } : {}),
  };
}

/** Groups leaves by a key derived from one field, preserving first-seen order. */
function groupBy(leaves: FlattenedAsset[], key: (leaf: FlattenedAsset) => string): Map<string, FlattenedAsset[]> {
  const buckets = new Map<string, FlattenedAsset[]>();
  for (const leaf of leaves) {
    const bucketKey = key(leaf);
    const bucket = buckets.get(bucketKey);
    if (bucket) bucket.push(leaf);
    else buckets.set(bucketKey, [leaf]);
  }
  return buckets;
}

/**
 * One `animationGroup` bucket → a `groupType: 'animation'` node. The node's
 * own `orientation`/`state` (not the members') are what `flattenManifest`
 * reads to recompute the same `animationGroup` string on re-flatten — see
 * the file header.
 */
function animationBucketToNode(leaves: FlattenedAsset[]): ManifestGroup {
  const sorted = [...leaves].sort((a, b) => (a.frame ?? 0) - (b.frame ?? 0));
  const first = sorted[0];
  return {
    type: 'group',
    groupType: 'animation',
    ...(first?.orientation ? { orientation: first.orientation } : {}),
    ...(first?.state ? { state: first.state } : {}),
    members: sorted.map(leafToAssetNode),
  };
}

function rotationBucketMembers(leaves: FlattenedAsset[]): ManifestNode[] {
  const animationBuckets = groupBy(leaves, (leaf) => leaf.animationGroup ?? '');
  const members: ManifestNode[] = [];
  for (const [animationKey, bucketLeaves] of animationBuckets) {
    if (animationKey === '') members.push(...bucketLeaves.map(leafToAssetNode));
    else members.push(animationBucketToNode(bucketLeaves));
  }
  return members;
}

function buildFurnitureManifest(asset: schema.CustomAsset): FurnitureManifest {
  const leaves = asset.manifest as FlattenedAsset[];
  const first = leaves[0] as FlattenedAsset;

  const base = {
    id: asset.assetId,
    name: asset.name,
    category: asset.category ?? '',
    canPlaceOnWalls: first.canPlaceOnWalls,
    canPlaceOnSurfaces: first.canPlaceOnSurfaces ?? false,
    backgroundTiles: first.backgroundTiles ?? 0,
  };

  // A lone leaf with no rotation/animation grouping — the docs' "simple asset" form.
  if (leaves.length === 1 && !first.rotationScheme && !first.animationGroup) {
    const only = leafToAssetNode(first);
    return {
      ...base,
      type: 'asset',
      file: only.file,
      width: only.width,
      height: only.height,
      footprintW: only.footprintW,
      footprintH: only.footprintH,
    };
  }

  const rotationBuckets = groupBy(leaves, (leaf) => leaf.rotationScheme ?? '');

  // The common case (one uniform rotationScheme, or none at all) — that one
  // bucket IS the root group, not wrapped inside a second one.
  if (rotationBuckets.size === 1) {
    const [scheme, bucketLeaves] = [...rotationBuckets][0] as [string, FlattenedAsset[]];
    return {
      ...base,
      type: 'group',
      groupType: 'rotation',
      ...(scheme ? { rotationScheme: scheme } : {}),
      members: rotationBucketMembers(bucketLeaves),
    };
  }

  // Rare: leaves under this asset carry more than one distinct
  // rotationScheme (only reachable via a deeply nested original upload,
  // since `rotationScheme` can vary per-leaf — see the file header). Each
  // scheme becomes its own nested rotation group, sibling to any leaves with
  // no scheme at all.
  const topMembers: ManifestNode[] = [];
  for (const [scheme, bucketLeaves] of rotationBuckets) {
    const members = rotationBucketMembers(bucketLeaves);
    if (scheme === '') topMembers.push(...members);
    else topMembers.push({ type: 'group', groupType: 'rotation', rotationScheme: scheme, members });
  }
  return { ...base, type: 'group', groupType: 'rotation', members: topMembers };
}

function addFurniture(zip: JSZip, asset: schema.CustomAsset): void {
  const manifest = buildFurnitureManifest(asset);
  const folder = zip.folder(`assets/furniture/${asset.assetId}`);
  if (!folder) return;
  folder.file('manifest.json', JSON.stringify(manifest, null, 2));

  const sprites = asset.sprites as Record<string, string[][]>;
  for (const leaf of asset.manifest as FlattenedAsset[]) {
    const grid = sprites[leaf.id];
    if (!grid) continue;
    folder.file(fileNameFor(leaf), encodeSpritePng(grid));
  }
}

function addPet(zip: JSZip, asset: schema.CustomAsset): void {
  // decodePet.ts always writes a single-element manifest array (schema.ts's
  // own comment on `manifest`: "character and pet are always a
  // single-element array").
  const [entry] = asset.manifest as [{ id: string; name: string }];
  const frames = (asset.sprites as Record<string, PetFrames>)[entry.id];
  if (!frames) return;

  const folder = zip.folder(`assets/pets/${asset.assetId}`);
  if (!folder) return;
  folder.file('manifest.json', JSON.stringify({ id: entry.id, name: entry.name }, null, 2));
  folder.file('pet.png', encodePetSheet(frames));
}

function addCharacter(zip: JSZip, asset: schema.CustomAsset, index: number): void {
  // Same single-element-manifest invariant as addPet() above.
  const [entry] = asset.manifest as [{ id: string }];
  const frames = (asset.sprites as Record<string, CharacterFrames>)[entry.id];
  if (!frames) return;
  zip.file(`assets/characters/char_${index}.png`, encodeCharacterSheet(frames));
}

/**
 * Builds the export zip for one or more custom assets, in the order given.
 * Character-kind assets are numbered sequentially (`char_0`, `char_1`, ...)
 * in that same order.
 */
export async function buildAssetsExportZip(assets: schema.CustomAsset[]): Promise<Buffer> {
  const zip = new JSZip();
  let characterIndex = 0;
  for (const asset of assets) {
    switch (asset.assetKind) {
      case 'furniture':
        addFurniture(zip, asset);
        break;
      case 'pet':
        addPet(zip, asset);
        break;
      case 'character':
        addCharacter(zip, asset, characterIndex);
        characterIndex += 1;
        break;
    }
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
