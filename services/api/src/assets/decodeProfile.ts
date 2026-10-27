/**
 * Turns an uploaded character profile into what `custom_assets` stores.
 *
 * A profile is the JSON file Pixel Agents' Characters view writes with
 * "Save config" and reads back with "Load config": a wardrobe part per slot,
 * colours and pixel edits, not pixels. It is stored as an ordinary
 * `character` asset tagged `profile` — the same row shape a sprite-sheet
 * character has, so every reader of character rows (gallery thumbnail,
 * poses, the live office, layout renders, exports) works on it unchanged —
 * with two additions: `manifest[0].profile` is the profile itself (what a
 * download hands back, ready for "Load config"), and `rawZip` holds the
 * uploaded JSON verbatim.
 *
 * Nothing here interprets the wardrobe. The renderer composes the profile
 * with upstream's own code (`requestCharacterComposition`: upstream's
 * `parseConfigFile` validates, migrates and names it exactly as "Load
 * config" would, then its wardrobe renderer draws the sheet), so what
 * pixel-index accepts and shows is what Pixel Agents itself would.
 */

import { ApiError } from '../errors.js';
import type { ComposedCharacter, ComposeFailure } from '../renderer/client.js';
import { CHARACTER_HEIGHT, CHARACTER_WIDTH, type CharacterFrames, type CharacterManifestEntry } from './decodeCharacter.js';
import { facingAssetTags, PROFILE_TAG } from './tags.js';
import { firstFreeId, type IdCollisionChecker, issue } from './zip.js';

/** A profile's file is a few kilobytes; pixel edits on every frame stay well under this. */
export const MAX_PROFILE_BYTES = 256 * 1024;

export interface ProfileManifestEntry extends CharacterManifestEntry {
  /** The profile as upstream reads it (migrated, named): what "Load config" takes back. */
  profile: Record<string, unknown>;
}

export interface DecodedProfileAsset {
  assetKind: 'character';
  assetId: string;
  requestedAssetId: string;
  name: string;
  category: null;
  manifest: [ProfileManifestEntry];
  sprites: Record<string, CharacterFrames>;
  /** A character's `['animated']`, plus `profile`. */
  tags: string[];
}

export type ComposeCharacter = (
  config: string,
  fileName: string,
) => Promise<{ ok: true; result: ComposedCharacter } | { ok: false; error: ComposeFailure }>;

/** 'Office Hero' → 'OFFICE_HERO'; an id that wouldn't start with a letter gets a `CHARACTER_` prefix. */
export function profileAssetId(name: string): string {
  const id = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return /^[A-Z]/.test(id) ? id : `CHARACTER${id ? `_${id}` : ''}`;
}

/**
 * Whether these upload bytes are meant as a profile: JSON whose first
 * non-blank character opens an object (or an array: a roster, refused with
 * its own reason). Settled before decoding so a malformed profile reports a
 * profile error, not "not a zip" — a zip always starts with `PK`.
 */
export function looksLikeProfile(buffer: Buffer): boolean {
  const text = buffer.subarray(0, 64).toString('utf8').trimStart();
  return text.startsWith('{') || text.startsWith('[');
}

export async function decodeCharacterProfile(
  buffer: Buffer,
  fileName: string,
  isIdTaken: IdCollisionChecker,
  compose: ComposeCharacter,
): Promise<DecodedProfileAsset> {
  if (buffer.byteLength > MAX_PROFILE_BYTES) {
    throw issue('/', `A character config must be at most ${MAX_PROFILE_BYTES} bytes (got ${buffer.byteLength}).`);
  }
  const config = buffer.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch {
    throw issue('/', 'The character config is not valid JSON.');
  }
  // A roster (an array, or `{ roster: [...] }`) is many characters; each is its own asset here.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || 'roster' in parsed) {
    throw issue('/', 'Upload one character config at a time — a roster holds several.');
  }

  const composed = await compose(config, fileName);
  if (!composed.ok) {
    if (composed.error.kind === 'invalid_profile') throw issue('/', composed.error.message);
    throw new ApiError(502, 'renderer_unavailable', composed.error.message);
  }
  const { profile, sprites } = composed.result;
  const name = (typeof profile.name === 'string' ? profile.name.trim() : '') || 'Character';

  const requestedId = profileAssetId(name);
  const assetId = firstFreeId(requestedId, isIdTaken);
  return {
    assetKind: 'character',
    assetId,
    requestedAssetId: requestedId,
    name,
    category: null,
    manifest: [{ id: assetId, name, label: name, width: CHARACTER_WIDTH, height: CHARACTER_HEIGHT, profile }],
    sprites: { [assetId]: sprites },
    tags: [...facingAssetTags(), PROFILE_TAG],
  };
}

/** The profile a character row carries, when it was published as one. */
export function profileOf(manifest: unknown): Record<string, unknown> | null {
  const [entry] = manifest as [{ profile?: unknown } | undefined];
  const profile = entry?.profile;
  return typeof profile === 'object' && profile !== null && !Array.isArray(profile)
    ? (profile as Record<string, unknown>)
    : null;
}
