/**
 * Turns an uploaded custom-character zip into what `custom_assets` stores.
 *
 * Characters have no manifest at all upstream — a character is one
 * `char_N.png` (112×96: 3 direction rows × 7 frames of 16×32 each), purely
 * positional (#105). This zip format mirrors that: exactly one PNG, no
 * `manifest.json` (rejected if present — the shape is deliberately
 * manifest-less, not "manifest optional").
 *
 * The 112×96 frame-grid layout is a hand-kept LOCAL copy of
 * `vendor/pixel-agents/core/src/assets/pngDecoder.ts`'s `decodeCharacterPng`
 * and `constants.ts`'s character constants, not an import of it — same
 * "read the pinned upstream's shape at the boundary, never cross it with a
 * module import" rule `manifest.ts`'s header already documents for
 * `tsconfig.build.json`'s `rootDir: "src"`. Keep this in sync by hand if
 * upstream's character sprite-sheet layout ever changes.
 */

import JSZip from 'jszip';
import { PNG } from 'pngjs';

import { firstFreeId, type IdCollisionChecker, issue, pngPaths } from './zip.js';

const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 32;
const CHAR_FRAMES_PER_ROW = 7;
const CHARACTER_DIRECTIONS = ['down', 'up', 'right'] as const;
export const CHARACTER_WIDTH = CHAR_FRAME_W * CHAR_FRAMES_PER_ROW; // 112
export const CHARACTER_HEIGHT = CHAR_FRAME_H * CHARACTER_DIRECTIONS.length; // 96

export interface CharacterFrames {
  down: string[][][];
  up: string[][][];
  right: string[][][];
}

export interface CharacterManifestEntry {
  id: string;
  name: string;
  label: string;
  width: number;
  height: number;
}

export interface DecodedCharacterAsset {
  assetKind: 'character';
  assetId: string;
  requestedAssetId: string;
  name: string;
  category: null;
  manifest: [CharacterManifestEntry];
  sprites: Record<string, CharacterFrames>;
}

/**
 * Strip trailing bytes after the PNG IEND chunk — Aseprite-generated PNGs
 * sometimes include trailing null bytes after IEND, which makes `pngjs`
 * throw. Ported from upstream's `pngDecoder.ts` (`sanitizePngBuffer`).
 */
function sanitizePngBuffer(buf: Buffer): Buffer {
  for (let i = buf.length - 8; i >= 8; i--) {
    if (buf[i] === 0x49 && buf[i + 1] === 0x45 && buf[i + 2] === 0x4e && buf[i + 3] === 0x44) {
      return buf.subarray(0, i + 8);
    }
  }
  return buf;
}

function decodeCharacterPng(buffer: Buffer, path: string): CharacterFrames {
  let png: PNG;
  try {
    png = PNG.sync.read(sanitizePngBuffer(buffer));
  } catch {
    throw issue(path, 'Could not be parsed as a PNG.');
  }
  if (png.width !== CHARACTER_WIDTH || png.height !== CHARACTER_HEIGHT) {
    throw issue(
      path,
      `A character sprite must be ${CHARACTER_WIDTH}×${CHARACTER_HEIGHT} but this PNG is ${png.width}×${png.height}.`,
    );
  }

  const result = { down: [], up: [], right: [] } as unknown as CharacterFrames;
  for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx++) {
    const dir = CHARACTER_DIRECTIONS[dirIdx] as (typeof CHARACTER_DIRECTIONS)[number];
    const rowOffsetY = dirIdx * CHAR_FRAME_H;
    const frames: string[][][] = [];
    for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
      const frameOffsetX = f * CHAR_FRAME_W;
      const sprite: string[][] = [];
      for (let y = 0; y < CHAR_FRAME_H; y++) {
        const row: string[] = [];
        for (let x = 0; x < CHAR_FRAME_W; x++) {
          const i = ((rowOffsetY + y) * png.width + (frameOffsetX + x)) * 4;
          const r = png.data[i];
          const g = png.data[i + 1];
          const b = png.data[i + 2];
          const a = png.data[i + 3];
          const hex = (n: number) => n.toString(16).padStart(2, '0');
          row.push(
            a === undefined || a < 2
              ? ''
              : a < 255
                ? `#${hex(r ?? 0)}${hex(g ?? 0)}${hex(b ?? 0)}${hex(a)}`
                : `#${hex(r ?? 0)}${hex(g ?? 0)}${hex(b ?? 0)}`,
          );
        }
        sprite.push(row);
      }
      frames.push(sprite);
    }
    result[dir] = frames;
  }
  return result;
}

export async function decodeCharacterZip(
  zipBuffer: Buffer,
  name: string,
  isIdTaken: IdCollisionChecker,
): Promise<DecodedCharacterAsset> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch {
    throw issue('/', 'Could not be read as a zip archive.');
  }

  const manifestCandidate = Object.keys(zip.files).find((entry) => entry.split('/').pop() === 'manifest.json');
  if (manifestCandidate) {
    throw issue('/', 'A custom character must not include a manifest.json — it is identified by its PNG alone.');
  }

  const pngs = pngPaths(zip);
  if (pngs.length === 0) throw issue('/', 'The zip does not contain a PNG.');
  if (pngs.length > 1) throw issue('/', 'The zip must contain exactly one PNG.');
  const path = pngs[0];
  if (path === undefined) throw issue('/', 'The zip does not contain a PNG.');
  const entry = zip.file(path);
  if (!entry) throw issue('/', 'The zip does not contain a PNG.');

  const buffer = await entry.async('nodebuffer');
  const frames = decodeCharacterPng(buffer, `/${path}`);

  // Pixel-index needs a stable id to address this row by (GET
  // /api/v1/assets/:assetId) even though upstream's own characters have no
  // id or name at all — derived from the display name, same character set
  // furniture ids already require.
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const requestedAssetId = slug === '' || !/^[A-Z]/.test(slug) ? `CHARACTER_${slug || 'UNNAMED'}` : slug;
  const assetId = firstFreeId(requestedAssetId, isIdTaken);

  return {
    assetKind: 'character',
    assetId,
    requestedAssetId,
    name,
    category: null,
    manifest: [{ id: assetId, name, label: name, width: CHARACTER_WIDTH, height: CHARACTER_HEIGHT }],
    sprites: { [assetId]: frames },
  };
}
