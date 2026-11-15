/**
 * Turns an uploaded custom-character zip into what `custom_assets` stores.
 *
 * A character is `manifest.json` (just `{id, name}`, same minimal shape as a
 * pet's) alongside one PNG (128×96: 3 direction rows × 8 frames of 16×32
 * each — walk1-3, type1-2, read1-2, seated), purely positional within the
 * sheet (#105). A sheet made before upstream's seated frame (112×96, 7
 * frames) is still accepted and widened the way upstream widens it. The manifest gives
 * pixel-index a stable id/name without asking the uploader to retype either —
 * the same reasoning `decodePet.ts` documents for pets.
 *
 * The manifest is validated against the published
 * `custom-asset-character-manifest.schema.json` contract, the same pattern
 * `decodePet.ts` follows for `custom-asset-pet-manifest.schema.json`.
 *
 * The 128×96 frame-grid layout is a hand-kept LOCAL copy of
 * `vendor/pixel-agents/core/src/assets/pngDecoder.ts`'s `decodeCharacterPng`,
 * `characterSheet.ts`, `seatedFrame.ts` and `constants.ts`'s character
 * constants, not an import of them — same
 * "read the pinned upstream's shape at the boundary, never cross it with a
 * module import" rule `manifest.ts`'s header already documents for
 * `tsconfig.build.json`'s `rootDir: "src"`. Keep this in sync by hand if
 * upstream's character sprite-sheet layout ever changes.
 */

import { customAssetCharacterManifestSchema, withFormats } from '@pixel-index/layout-core';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import JSZip from 'jszip';
import { PNG } from 'pngjs';

import { ApiError } from '../errors.js';
import { encodeSpritePng } from './spritePng.js';
import { facingAssetTags } from './tags.js';
import {
  findNamedTextEntry,
  firstFreeId,
  type IdCollisionChecker,
  issue,
  issuesFromAjvErrors,
  pngPaths,
} from './zip.js';

const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 32;
const CHAR_FRAMES_PER_ROW = 8;
/** Frames per row of a sheet made before upstream's seated frame (column 7, last). */
const LEGACY_FRAMES_PER_ROW = 7;
/** The typing frames the seated frame is derived from (upstream's `seatedFrame.ts`). */
const TYPE1 = 3;
const TYPE2 = 4;
const CHARACTER_DIRECTIONS = ['down', 'up', 'right'] as const;
export const CHARACTER_WIDTH = CHAR_FRAME_W * CHAR_FRAMES_PER_ROW; // 128
export const LEGACY_CHARACTER_WIDTH = CHAR_FRAME_W * LEGACY_FRAMES_PER_ROW; // 112
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
  /** Always `['animated']` — see `tags.ts`'s file header for why. */
  tags: string[];
}

/**
 * A direction row's seated frame, built from its typing frames by upstream's
 * one recipe (`seatedSource`): side-on is type1; front and back take their
 * left half from type2 and their right half from type1.
 */
function seatedFrame(dir: (typeof CHARACTER_DIRECTIONS)[number], frames: string[][][]): string[][] {
  const type1 = frames[TYPE1] ?? [];
  const type2 = frames[TYPE2] ?? [];
  return Array.from({ length: CHAR_FRAME_H }, (_, y) =>
    Array.from({ length: CHAR_FRAME_W }, (_, x) => {
      const source = dir === 'right' || x >= CHAR_FRAME_W / 2 ? type1 : type2;
      return source[y]?.[x] ?? '';
    }),
  );
}

/**
 * Stored frames in the current 8-frame layout. Rows decoded before the
 * seated frame existed hold 7 frames per direction; they gain the seated
 * frame here, wherever they leave the API, instead of by a data migration.
 */
export function currentCharacterFrames(frames: CharacterFrames): CharacterFrames {
  const widen = (dir: (typeof CHARACTER_DIRECTIONS)[number]) => {
    const row = frames[dir];
    return row.length === LEGACY_FRAMES_PER_ROW ? [...row, seatedFrame(dir, row)] : row;
  };
  return { down: widen('down'), up: widen('up'), right: widen('right') };
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
  if ((png.width !== CHARACTER_WIDTH && png.width !== LEGACY_CHARACTER_WIDTH) || png.height !== CHARACTER_HEIGHT) {
    throw issue(
      path,
      `A character sprite must be ${CHARACTER_WIDTH}×${CHARACTER_HEIGHT} (or ${LEGACY_CHARACTER_WIDTH}×${CHARACTER_HEIGHT} without the seated frame) but this PNG is ${png.width}×${png.height}.`,
    );
  }
  const framesPerRow = png.width / CHAR_FRAME_W;

  const result = { down: [], up: [], right: [] } as unknown as CharacterFrames;
  for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx++) {
    const dir = CHARACTER_DIRECTIONS[dirIdx] as (typeof CHARACTER_DIRECTIONS)[number];
    const rowOffsetY = dirIdx * CHAR_FRAME_H;
    const frames: string[][][] = [];
    for (let f = 0; f < framesPerRow; f++) {
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
  return currentCharacterFrames(result);
}

/**
 * The exact inverse of `decodeCharacterPng` — reassembles the 128×96,
 * 3-direction × 8-frame sheet a `char_N.png` external-asset file must be
 * (#119's export path, `exportZip.ts`), so pixel-agents' own
 * `decodeCharacterPng` (which this codebase's copy is pinned to, see the
 * file header) reads it back identically to how it was originally decoded.
 */
export function encodeCharacterSheet(frames: CharacterFrames): Buffer {
  const current = currentCharacterFrames(frames);
  const grid: string[][] = [];
  for (const dir of CHARACTER_DIRECTIONS) {
    for (let y = 0; y < CHAR_FRAME_H; y++) {
      const row: string[] = [];
      for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
        const frame = current[dir][f];
        for (let x = 0; x < CHAR_FRAME_W; x++) {
          row.push(frame?.[y]?.[x] ?? '');
        }
      }
      grid.push(row);
    }
  }
  return encodeSpritePng(grid);
}

const ajv = withFormats(new Ajv2020({ allErrors: true, strict: false }));
const validateCharacterManifest: ValidateFunction = ajv.compile(customAssetCharacterManifestSchema);

export async function decodeCharacterZip(
  zipBuffer: Buffer,
  isIdTaken: IdCollisionChecker,
): Promise<DecodedCharacterAsset> {
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
  if (!validateCharacterManifest(parsed)) {
    throw ApiError.validation(
      issuesFromAjvErrors(validateCharacterManifest.errors).map((i) => ({
        code: 'meta.schema' as const,
        path: i.path,
        message: i.message,
      })),
      'Invalid manifest.json.',
    );
  }
  const { id: requestedId, name } = parsed as { id: string; name: string };

  const pngs = pngPaths(zip, dir);
  if (pngs.length === 0) throw issue('/', `No PNG was found alongside manifest.json in "${dir || '.'}".`);
  if (pngs.length > 1) throw issue('/', `Expected exactly one PNG alongside manifest.json in "${dir || '.'}".`);
  const path = pngs[0];
  if (path === undefined) throw issue('/', 'The zip does not contain a PNG.');
  const entry = zip.file(path);
  if (!entry) throw issue('/', 'The zip does not contain a PNG.');

  const buffer = await entry.async('nodebuffer');
  const frames = decodeCharacterPng(buffer, `/${path}`);

  const assetId = firstFreeId(requestedId, isIdTaken);

  return {
    assetKind: 'character',
    assetId,
    requestedAssetId: requestedId,
    name,
    category: null,
    manifest: [{ id: assetId, name, label: name, width: CHARACTER_WIDTH, height: CHARACTER_HEIGHT }],
    sprites: { [assetId]: frames },
    tags: facingAssetTags(),
  };
}
