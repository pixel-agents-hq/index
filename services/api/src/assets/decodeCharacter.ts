/**
 * Turns an uploaded custom-character zip into what `custom_assets` stores.
 *
 * A character is `manifest.json` (just `{id, name}`, same minimal shape as a
 * pet's) alongside one PNG (112×96: 3 direction rows × 7 frames of 16×32
 * each), purely positional within the sheet (#105). The manifest gives
 * pixel-index a stable id/name without asking the uploader to retype either —
 * the same reasoning `decodePet.ts` documents for pets.
 *
 * The manifest is validated against the published
 * `custom-asset-character-manifest.schema.json` contract, the same pattern
 * `decodePet.ts` follows for `custom-asset-pet-manifest.schema.json`.
 *
 * The 112×96 frame-grid layout is a hand-kept LOCAL copy of
 * `vendor/pixel-agents/core/src/assets/pngDecoder.ts`'s `decodeCharacterPng`
 * and `constants.ts`'s character constants, not an import of it — same
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
  /** Always `['animated']` — see `tags.ts`'s file header for why. */
  tags: string[];
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
