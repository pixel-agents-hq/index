/**
 * Syncs the built-in Pixel Agents catalog (`vendor/pixel-agents/webview-ui/
 * public/assets/{furniture,characters,pets}`) into `custom_assets`, tagged
 * `source: 'builtin'`, so `GET /api/v1/assets` lists/filters/paginates
 * across built-in and uploaded assets uniformly. See `docs/custom-assets.md`'s
 * "Extending the gallery to built-in assets" section for the full design.
 *
 * Reconciled, not decoded per request: every boot compares the pinned
 * commit (`vendor/pixel-agents.commit`) against what is already stored and
 * no-ops when nothing changed — most boots pay zero decode cost. When the
 * pin has moved (or on a fresh install), every `source = 'builtin'` row is
 * replaced in one transaction; `source = 'custom'` rows are never
 * referenced by that transaction's DELETE and are therefore never at risk.
 *
 * Reuses the exact same decode functions an upload goes through
 * (`decodeFurnitureZip`/`decodeCharacterZip`/`decodePetZip`) — a built-in
 * asset is validated and decoded by the same code path as a human's upload,
 * not a parallel one that could drift. Those functions take a zip `Buffer`
 * and parse it themselves, so this module's job is to build one small
 * in-memory zip per vendor asset from files already on disk, exactly as a
 * human uploader's client would have, then hand it to the existing decoder.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { upstreamAssetsDir, upstreamPin } from '@pixel-index/layout-core';
import { eq } from 'drizzle-orm';
import JSZip from 'jszip';

import type { AnyDatabase } from '../db/client.js';
import { PIXEL_AGENTS_SYSTEM_USER_ID } from '../db/constants.js';
import * as schema from '../db/schema.js';
import { type DecodedFurnitureAsset, decodeFurnitureZip } from './decode.js';
import { decodeCharacterZip,type DecodedCharacterAsset } from './decodeCharacter.js';
import { type DecodedPetAsset, decodePetZip } from './decodePet.js';
import type { IdCollisionChecker } from './zip.js';

export interface BuiltinSyncResult {
  synced: boolean;
  count: number;
  commit: string | null;
}

type DecodedAsset = DecodedFurnitureAsset | DecodedCharacterAsset | DecodedPetAsset;

async function buildZip(files: Record<string, Buffer | string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, contents] of Object.entries(files)) {
    zip.file(name, contents);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

interface VendorFurnitureManifest {
  id: string;
  name: string;
  category: string;
  type: 'asset' | 'group';
  file?: string;
}

/**
 * One `furniture/<ID>/{manifest.json, *.png}` vendor directory, zipped as it
 * sits on disk (manifest.json + every PNG at the zip root, same flat shape
 * `decodeFurnitureZip` already expects — `manifest.file` fields are bare
 * filenames, resolved relative to the manifest's own zip directory) — with
 * one normalization: a flat (`type: "asset"`) vendor manifest omits `file`
 * entirely (upstream's own loader defaults it to `<id>.png`), but the
 * upload-validation schema requires it explicitly. A nested group's own
 * members always specify `file` already, so this only ever fires at the
 * root, and only for the single-PNG case where `<id>.png` is unambiguous.
 */
async function decodeBuiltinFurniture(
  dirPath: string,
  isIdTaken: IdCollisionChecker,
): Promise<{ decoded: DecodedFurnitureAsset; zipBuffer: Buffer }> {
  const manifestRaw = fs.readFileSync(path.join(dirPath, 'manifest.json'), 'utf-8');
  const manifest = JSON.parse(manifestRaw) as VendorFurnitureManifest;
  const manifestForZip =
    manifest.type === 'asset' && !manifest.file
      ? JSON.stringify({ ...manifest, file: `${manifest.id}.png` })
      : manifestRaw;

  const files: Record<string, Buffer | string> = { 'manifest.json': manifestForZip };
  for (const entry of fs.readdirSync(dirPath)) {
    if (entry.toLowerCase().endsWith('.png')) {
      files[entry] = fs.readFileSync(path.join(dirPath, entry));
    }
  }

  const zipBuffer = await buildZip(files);
  const decoded = await decodeFurnitureZip(zipBuffer, isIdTaken);
  return { decoded, zipBuffer };
}

/**
 * One `characters/char_N.png` vendor file. Upstream characters have no
 * manifest or id at all — `decodeCharacterZip` now requires one (#105
 * follow-up: custom character uploads carry `manifest.json` too, mirroring
 * pets), so a synthetic `{id, name}` manifest is built here the same way
 * `decodeBuiltinPet` already does for vendor pets, deriving the id from the
 * file's own index (`char_0.png` → `CHAR_0`).
 */
async function decodeBuiltinCharacter(
  pngPath: string,
  index: number,
  label: string,
  isIdTaken: IdCollisionChecker,
): Promise<{ decoded: DecodedCharacterAsset; zipBuffer: Buffer }> {
  const syntheticManifest = { id: `CHAR_${index}`, name: label };
  const zipBuffer = await buildZip({
    'manifest.json': JSON.stringify(syntheticManifest),
    [path.basename(pngPath)]: fs.readFileSync(pngPath),
  });
  const decoded = await decodeCharacterZip(zipBuffer, isIdTaken);
  return { decoded, zipBuffer };
}

interface VendorPetManifest {
  id: string;
  name: string;
}

/**
 * One `pets/<id>/{manifest.json, pet.png}` vendor directory. The manifest
 * fed to `decodePetZip` is a *synthetic* one, not the vendor file's bytes
 * verbatim: vendor pet ids (`gitcat`, `claudio`) are lowercase, and
 * `custom_assets_asset_id_format` requires `^[A-Z][A-Z0-9_]*$` — the id is
 * upper-cased here (`GITCAT`, `CLAUDIO`) while `name` keeps its original
 * casing for display.
 */
async function decodeBuiltinPet(
  dirPath: string,
  isIdTaken: IdCollisionChecker,
): Promise<{ decoded: DecodedPetAsset; zipBuffer: Buffer }> {
  const vendorManifest = JSON.parse(
    fs.readFileSync(path.join(dirPath, 'manifest.json'), 'utf-8'),
  ) as VendorPetManifest;
  const syntheticManifest = { id: vendorManifest.id.toUpperCase(), name: vendorManifest.name };

  const zipBuffer = await buildZip({
    'manifest.json': JSON.stringify(syntheticManifest),
    'pet.png': fs.readFileSync(path.join(dirPath, 'pet.png')),
  });
  const decoded = await decodePetZip(zipBuffer, isIdTaken);
  return { decoded, zipBuffer };
}

function toRow(decoded: DecodedAsset, zipBuffer: Buffer, commit: string): schema.NewCustomAsset {
  return {
    assetKind: decoded.assetKind,
    assetId: decoded.assetId,
    requestedAssetId: decoded.requestedAssetId,
    name: decoded.name,
    category: decoded.category,
    manifest: decoded.manifest,
    sprites: decoded.sprites,
    tags: decoded.tags,
    // The synthetic zip's own bytes — the actual decode input, meaningful
    // and traceable, not a duplicate of the vendor tree's raw files.
    rawZip: zipBuffer,
    authorUserId: PIXEL_AGENTS_SYSTEM_USER_ID,
    source: 'builtin',
    sourceCommit: commit,
  };
}

const CHARACTER_PNG_RE = /^char_(\d+)\.png$/;

export async function syncBuiltinAssets(db: AnyDatabase, upstreamDir?: string): Promise<BuiltinSyncResult> {
  const pin = upstreamPin(upstreamDir);
  if (!pin.commit) {
    // Never delete existing builtin rows against an unresolvable identity —
    // there would be no way to tell "nothing to sync" from "about to lose
    // every built-in asset until the next successful boot".
    console.warn('Could not resolve the pinned pixel-agents commit; skipping built-in asset sync.');
    return { synced: false, count: 0, commit: null };
  }

  const stored = await db
    .selectDistinct({ sourceCommit: schema.customAssets.sourceCommit })
    .from(schema.customAssets)
    .where(eq(schema.customAssets.source, 'builtin'));
  if (stored.length === 1 && stored[0]?.sourceCommit === pin.commit) {
    return { synced: false, count: 0, commit: pin.commit };
  }

  const assetsDir = upstreamAssetsDir(upstreamDir);
  const commit = pin.commit;

  const count = await db.transaction(async (tx: AnyDatabase) => {
    // Scoped delete — this statement never touches source = 'custom' rows.
    await tx.delete(schema.customAssets).where(eq(schema.customAssets.source, 'builtin'));

    // Seeded from whatever survives the delete above (i.e. every remaining
    // 'custom' row), then grown as each builtin asset below is assigned an
    // id — required so two built-ins decoded in the same batch can't
    // collide with each other, not just with pre-existing DB state.
    const remaining = await tx.select({ assetId: schema.customAssets.assetId }).from(schema.customAssets);
    const claimed = new Set(remaining.map((row) => row.assetId));
    const isIdTaken: IdCollisionChecker = (id) => claimed.has(id);

    const rows: schema.NewCustomAsset[] = [];

    // Deterministic processing order, so re-runs are reproducible: sorted
    // furniture directories, then characters by index, then sorted pet
    // directories.
    const furnitureDir = path.join(assetsDir, 'furniture');
    const furnitureIds = fs.existsSync(furnitureDir)
      ? fs
          .readdirSync(furnitureDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
      : [];
    for (const id of furnitureIds) {
      const { decoded, zipBuffer } = await decodeBuiltinFurniture(path.join(furnitureDir, id), isIdTaken);
      claimed.add(decoded.assetId);
      rows.push(toRow(decoded, zipBuffer, commit));
    }

    const charactersDir = path.join(assetsDir, 'characters');
    const characterIndices = fs.existsSync(charactersDir)
      ? fs
          .readdirSync(charactersDir)
          .map((name) => CHARACTER_PNG_RE.exec(name))
          .filter((match): match is RegExpExecArray => match !== null)
          .map((match) => Number(match[1]))
          .sort((a, b) => a - b)
      : [];
    for (const n of characterIndices) {
      const { decoded, zipBuffer } = await decodeBuiltinCharacter(
        path.join(charactersDir, `char_${n}.png`),
        n,
        `Char ${n}`,
        isIdTaken,
      );
      claimed.add(decoded.assetId);
      rows.push(toRow(decoded, zipBuffer, commit));
    }

    const petsDir = path.join(assetsDir, 'pets');
    const petIds = fs.existsSync(petsDir)
      ? fs
          .readdirSync(petsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
      : [];
    for (const id of petIds) {
      const { decoded, zipBuffer } = await decodeBuiltinPet(path.join(petsDir, id), isIdTaken);
      claimed.add(decoded.assetId);
      rows.push(toRow(decoded, zipBuffer, commit));
    }

    if (rows.length > 0) {
      await tx.insert(schema.customAssets).values(rows);
    }
    return rows.length;
  });

  console.log(`Synced ${count} builtin asset(s) from pixel-agents ${commit.slice(0, 7)}.`);
  return { synced: true, count, commit };
}
