/**
 * Turns an uploaded custom-pet zip into what `custom_assets` stores.
 *
 * Pets are `<id>/{manifest.json, pet.png}` upstream (#105) — a manifest of
 * just `{id, name}` (upstream drops `id` again once it reaches the client;
 * pixel-index keeps it in the manifest entry anyway, for `GET
 * /api/v1/assets/:assetId`'s own sake) and one 96×96 PNG laid out as a fixed
 * frame grid: row 0 = walkDown[0..2] + idleDown[0..2] (16w each), row 1 =
 * walkUp[0..2] + idleUp[0..2] (16w each), row 2 = walkRight[0..2] (32w each).
 *
 * The frame-grid layout is a hand-kept LOCAL copy of
 * `vendor/pixel-agents/core/src/assets/pngDecoder.ts`'s `decodePetPng` and
 * `constants.ts`'s pet constants, not an import of it — same boundary rule
 * `decodeCharacter.ts` and `manifest.ts` already follow. Keep this in sync by
 * hand if upstream's pet sprite-sheet layout ever changes.
 */

import JSZip from 'jszip';
import { PNG } from 'pngjs';

import { ASSET_ID_RE } from './manifest.js';
import { findNamedTextEntry, firstFreeId, type IdCollisionChecker, issue, pngPaths } from './zip.js';

const PET_FRAME_W_SMALL = 16;
const PET_FRAME_H = 32;
const PET_FRAME_W_LARGE = 32;
export const PET_WIDTH = 96;
export const PET_HEIGHT = 96;
const PET_WALK_FRAMES_VERT = 3;
const PET_IDLE_FRAMES_VERT = 3;
const PET_WALK_FRAMES_HORIZ = 3;

export interface PetFrames {
  walkDown: string[][][];
  idleDown: string[][][];
  walkUp: string[][][];
  idleUp: string[][][];
  walkRight: string[][][];
}

export interface PetManifestEntry {
  id: string;
  name: string;
  width: number;
  height: number;
}

export interface DecodedPetAsset {
  assetKind: 'pet';
  assetId: string;
  requestedAssetId: string;
  name: string;
  category: null;
  manifest: [PetManifestEntry];
  sprites: Record<string, PetFrames>;
}

function sanitizePngBuffer(buf: Buffer): Buffer {
  for (let i = buf.length - 8; i >= 8; i--) {
    if (buf[i] === 0x49 && buf[i + 1] === 0x45 && buf[i + 2] === 0x4e && buf[i + 3] === 0x44) {
      return buf.subarray(0, i + 8);
    }
  }
  return buf;
}

function toHex(r: number, g: number, b: number, a: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return a < 255 ? `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}` : `#${hex(r)}${hex(g)}${hex(b)}`;
}

function decodePetPng(buffer: Buffer, path: string): PetFrames {
  let png: PNG;
  try {
    png = PNG.sync.read(sanitizePngBuffer(buffer));
  } catch {
    throw issue(path, 'Could not be parsed as a PNG.');
  }
  if (png.width !== PET_WIDTH || png.height !== PET_HEIGHT) {
    throw issue(path, `A pet sprite must be ${PET_WIDTH}×${PET_HEIGHT} but this PNG is ${png.width}×${png.height}.`);
  }

  function extractFrame(ox: number, oy: number, w: number, h: number): string[][] {
    const sprite: string[][] = [];
    for (let y = 0; y < h; y++) {
      const row: string[] = [];
      for (let x = 0; x < w; x++) {
        const i = ((oy + y) * png.width + (ox + x)) * 4;
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

  const walkDown: string[][][] = [];
  for (let f = 0; f < PET_WALK_FRAMES_VERT; f++) {
    walkDown.push(extractFrame(f * PET_FRAME_W_SMALL, 0, PET_FRAME_W_SMALL, PET_FRAME_H));
  }
  const idleDown: string[][][] = [];
  for (let f = 0; f < PET_IDLE_FRAMES_VERT; f++) {
    idleDown.push(extractFrame((PET_WALK_FRAMES_VERT + f) * PET_FRAME_W_SMALL, 0, PET_FRAME_W_SMALL, PET_FRAME_H));
  }
  const walkUp: string[][][] = [];
  for (let f = 0; f < PET_WALK_FRAMES_VERT; f++) {
    walkUp.push(extractFrame(f * PET_FRAME_W_SMALL, PET_FRAME_H, PET_FRAME_W_SMALL, PET_FRAME_H));
  }
  const idleUp: string[][][] = [];
  for (let f = 0; f < PET_IDLE_FRAMES_VERT; f++) {
    idleUp.push(
      extractFrame((PET_WALK_FRAMES_VERT + f) * PET_FRAME_W_SMALL, PET_FRAME_H, PET_FRAME_W_SMALL, PET_FRAME_H),
    );
  }
  const walkRight: string[][][] = [];
  for (let f = 0; f < PET_WALK_FRAMES_HORIZ; f++) {
    walkRight.push(extractFrame(f * PET_FRAME_W_LARGE, PET_FRAME_H * 2, PET_FRAME_W_LARGE, PET_FRAME_H));
  }

  return { walkDown, idleDown, walkUp, idleUp, walkRight };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function decodePetZip(
  zipBuffer: Buffer,
  name: string,
  isIdTaken: IdCollisionChecker,
): Promise<DecodedPetAsset> {
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
  if (!isRecord(parsed)) throw issue('/manifest.json', 'manifest.json must be a JSON object.');
  const requestedId = parsed.id;
  if (typeof requestedId !== 'string' || !ASSET_ID_RE.test(requestedId)) {
    throw issue('/manifest.json/id', 'id must start with an uppercase letter and contain only A-Z, 0-9, underscore.');
  }
  const manifestName = parsed.name;
  if (typeof manifestName !== 'string' || manifestName.trim() === '') {
    throw issue('/manifest.json/name', 'name is required.');
  }

  const pngs = pngPaths(zip, dir);
  if (pngs.length === 0) throw issue('/', `No PNG was found alongside manifest.json in "${dir || '.'}".`);
  if (pngs.length > 1) throw issue('/', `Expected exactly one PNG alongside manifest.json in "${dir || '.'}".`);
  const path = pngs[0];
  if (path === undefined) throw issue('/', 'The zip does not contain a PNG.');
  const entry = zip.file(path);
  if (!entry) throw issue('/', 'The zip does not contain a PNG.');

  const buffer = await entry.async('nodebuffer');
  const frames = decodePetPng(buffer, `/${path}`);

  const assetId = firstFreeId(requestedId, isIdTaken);

  return {
    assetKind: 'pet',
    assetId,
    requestedAssetId: requestedId,
    name,
    category: null,
    manifest: [{ id: assetId, name, width: PET_WIDTH, height: PET_HEIGHT }],
    sprites: { [assetId]: frames },
  };
}
