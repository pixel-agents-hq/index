/**
 * Syncs the built-in Pixel Agents catalog (`vendor/pixel-agents/webview-ui/
 * public/assets/{furniture,pets}`, plus upstream's default character
 * profiles from `builtinProfiles.json`) into `custom_assets`, tagged
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
import { and, eq } from 'drizzle-orm';
import JSZip from 'jszip';

import type { AnyDatabase } from '../db/client.js';
import { PIXEL_AGENTS_SYSTEM_USER_ID } from '../db/constants.js';
import * as schema from '../db/schema.js';
import builtinProfiles from './builtinProfiles.json' with { type: 'json' };
import { type DecodedFurnitureAsset, decodeFurnitureZip } from './decode.js';
import { decodeCharacterZip,type DecodedCharacterAsset } from './decodeCharacter.js';
import { type DecodedPetAsset, decodePetZip } from './decodePet.js';
import { type DecodedProfileAsset, profileOf } from './decodeProfile.js';
import { PROFILE_TAG } from './tags.js';
import type { IdCollisionChecker } from './zip.js';

export interface BuiltinSyncResult {
  synced: boolean;
  count: number;
  commit: string | null;
}

type DecodedAsset = DecodedFurnitureAsset | DecodedCharacterAsset | DecodedPetAsset | DecodedProfileAsset;

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

/** One of upstream's default character profiles, as `apps/web/build/generateBuiltinProfiles.ts` wrote it. */
export interface BuiltinProfile {
  profile: { id?: string; name?: string } & Record<string, unknown>;
  /** Its sheet, composed by upstream's own wardrobe renderer: a 128×96 PNG, base64. */
  sheetPng: string;
}

/**
 * One of upstream's default character profiles. Upstream no longer bundles
 * `characters/char_N.png`: its cast is profiles drawn from wardrobe parts,
 * so a built-in character is published as a profile, the way an uploaded
 * one is (`decodeProfile.ts`): its composed sheet decoded by
 * `decodeCharacterZip` like any character, the profile kept beside it. The
 * id comes from the profile's own (`char-0` → `CHAR_0`), the same ids the
 * bundled `char_N.png` characters had, so their URLs keep working.
 */
async function decodeBuiltinProfile(
  { profile, sheetPng }: BuiltinProfile,
  index: number,
  isIdTaken: IdCollisionChecker,
): Promise<{ decoded: DecodedProfileAsset; zipBuffer: Buffer }> {
  const id = (profile.id ?? `char-${index}`).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const name = profile.name || `Char ${index}`;
  const zipBuffer = await buildZip({
    'manifest.json': JSON.stringify({ id, name }),
    'char.png': Buffer.from(sheetPng, 'base64'),
    'profile.json': JSON.stringify(profile, null, 2),
  });
  const decoded = await decodeCharacterZip(zipBuffer, isIdTaken);
  const [entry] = decoded.manifest;
  return {
    decoded: { ...decoded, manifest: [{ ...entry, profile }], tags: [...decoded.tags, PROFILE_TAG] },
    zipBuffer,
  };
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

/**
 * Whether the built-in profiles already stored are exactly `profiles`. The
 * pinned commit alone can't say: the profiles come from this repo's
 * `builtinProfiles.json`, not from the vendor tree, so the pin can stay put
 * while they change — the first deploy carrying them landed on a database
 * already synced at the same pin, without profiles, and the commit check
 * alone kept it that way.
 */
/** JSON with object keys sorted — `jsonb` doesn't keep the order a profile was written in. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

async function storedProfilesMatch(db: AnyDatabase, profiles: readonly BuiltinProfile[]): Promise<boolean> {
  const rows = await db
    .select({ manifest: schema.customAssets.manifest })
    .from(schema.customAssets)
    .where(and(eq(schema.customAssets.source, 'builtin'), eq(schema.customAssets.assetKind, 'character')));
  const stored = rows.map((row) => canonicalJson(profileOf(row.manifest))).sort();
  const expected = profiles.map((p) => canonicalJson(p.profile)).sort();
  return stored.length === expected.length && stored.every((profile, i) => profile === expected[i]);
}

export async function syncBuiltinAssets(
  db: AnyDatabase,
  upstreamDir?: string,
  profiles: readonly BuiltinProfile[] = builtinProfiles.profiles,
): Promise<BuiltinSyncResult> {
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
  if (
    stored.length === 1 &&
    stored[0]?.sourceCommit === pin.commit &&
    (await storedProfilesMatch(db, profiles))
  ) {
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
    // furniture directories, then the default profiles in cast order, then sorted pet
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

    for (const [n, profile] of profiles.entries()) {
      const { decoded, zipBuffer } = await decodeBuiltinProfile(profile, n, isIdTaken);
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
