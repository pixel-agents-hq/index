/**
 * Shared zip/PNG plumbing for every custom-asset kind's decode module
 * (`decode.ts` furniture, `decodeCharacter.ts`, `decodePet.ts`) — extracted
 * from what was originally furniture-only `decode.ts` (#105) so the two new
 * kinds don't each reimplement "find a file in the zip", "decode a PNG
 * strictly", "suffix a colliding id", and (#107 follow-up) "turn an ajv
 * schema-validation failure into a 422".
 */

import type { ErrorObject } from 'ajv';
import type JSZip from 'jszip';
import { PNG } from 'pngjs';

import { ApiError } from '../errors.js';

export function issue(path: string, message: string): ApiError {
  return ApiError.validation([{ code: 'meta.schema', path, message }], 'Invalid custom asset upload.');
}

export interface SchemaIssue {
  path: string;
  message: string;
}

/**
 * Turns ajv's `ErrorObject[]` into the flat `{path, message}` shape a 422
 * response body reports — shared by `manifest.ts` (furniture) and
 * `decodePet.ts` (pet), the two manifest kinds now validated against their
 * published JSON Schema (`packages/layout-core/schema/`, #107) instead of
 * hand-written checks, so the two can't drift apart again.
 *
 * A `required` error's `instancePath` points at the PARENT object, not the
 * missing field, so this appends `missingProperty` to recover a path that
 * actually names the field — `/id` rather than `/` for a manifest missing
 * `id`.
 */
export function issuesFromAjvErrors(errors: ErrorObject[] | null | undefined): SchemaIssue[] {
  return (errors ?? []).map((error) => {
    const missingProperty =
      error.keyword === 'required' ? (error.params as { missingProperty?: string }).missingProperty : undefined;
    const path = missingProperty ? `${error.instancePath}/${missingProperty}` : error.instancePath || '/';
    return { path, message: `${path} ${error.message ?? 'is invalid'}`.trim() };
  });
}

/** Checks a candidate id (and everywhere it appears in a manifest tree) for uniqueness. */
export type IdCollisionChecker = (id: string) => boolean;

/** Suffixes `_2`, `_3`, ... onto `id` until `isTaken` says no one holds it. */
export function firstFreeId(id: string, isTaken: IdCollisionChecker): string {
  if (!isTaken(id)) return id;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${id}_${n}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new ApiError(500, 'internal_error', 'Could not find a free asset id.');
}

function toHex(r: number, g: number, b: number, a: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return a < 255 ? `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}` : `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * Strict `pngToSpriteData`: rejects a PNG whose actual dimensions don't match
 * the declared `width`/`height`, rather than upstream's own
 * silent-warn-and-misread-the-buffer behavior — the right default for a
 * bundled, trusted asset pack is not the right default for an untrusted
 * upload.
 */
export function decodePng(buffer: Buffer, width: number, height: number, path: string): string[][] {
  let png: PNG;
  try {
    png = PNG.sync.read(buffer);
  } catch {
    throw issue(path, 'Could not be parsed as a PNG.');
  }
  if (png.width !== width || png.height !== height) {
    throw issue(path, `Declared ${width}×${height} but the PNG is actually ${png.width}×${png.height}.`);
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

export interface ZipTextEntry {
  /** The directory the entry lives in, `''` at the zip root, always ending in `/` otherwise. */
  dir: string;
  text: string;
}

/**
 * Finds the one file named `filename` anywhere in the zip and returns its
 * directory + text content. Returns `null` if there is none — callers decide
 * whether that's an error (furniture, pet) or the expected shape (character).
 * Throws if there's more than one, the same ambiguity furniture's original
 * `findManifestEntry` already refused to guess at.
 */
export async function findNamedTextEntry(zip: JSZip, filename: string): Promise<ZipTextEntry | null> {
  const candidates = Object.keys(zip.files).filter((name) => name.split('/').pop() === filename);
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw issue('/', `The zip must contain at most one ${filename}.`);
  }
  const path = candidates[0];
  if (path === undefined) return null;
  const entry = zip.file(path);
  if (!entry) return null;
  const text = await entry.async('text');
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  return { dir, text };
}

/** Every `.png` path in the zip, optionally restricted to files directly inside `dir` (`''` = root). */
export function pngPaths(zip: JSZip, dir?: string): string[] {
  return Object.keys(zip.files).filter((name) => {
    if (!name.toLowerCase().endsWith('.png')) return false;
    if (dir === undefined) return true;
    const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : '';
    return parent === dir;
  });
}
