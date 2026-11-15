/**
 * Avatar PNGs from seed codes (#133), drawn by `@pixel-index/pixatar`.
 *
 * Only seed codes (`px.` + base64url) are drawn, never free text. A free-text
 * seed is whatever the caller typed — a username, an email address — and a GET
 * path lands in every access log between the caller and here. A seed code is
 * the character itself and says nothing about where it came from, so a caller
 * that starts from text makes the code locally (`seedFromText`, or the Python
 * client's `from_text`) and asks for that.
 *
 * The package's dist bundles the pinned wardrobe and renderer, so nothing of
 * vendor/pixel-agents is read at runtime: the API image needs only the built
 * package (services/api/Dockerfile).
 */

import { createHash } from 'node:crypto';

import { isSeedCode, pixatar, PixatarError, VENDOR } from '@pixel-index/pixatar';

import { ApiError } from '../errors.js';

/**
 * Longest seed code drawn. A compact code is ~35–110 characters; a packed one
 * (pixel edits) is deflated JSON and longer. The cap also bounds the inflate:
 * deflate tops out near 1000:1, so 1024 characters (~760 bytes) cannot expand
 * past a megabyte of JSON.
 */
export const MAX_SEED_CODE_LENGTH = 1024;
/** The avatar is 20×20 pixels times this. 8 (160×160) is what the cogs bot draws. */
export const DEFAULT_AVATAR_SCALE = 8;
/**
 * The package allows 64, but a render costs scale² (measured: ~5ms at 8, ~17ms
 * at 16, ~250ms at 64) and runs on the event loop. 16 is 320×320, already
 * larger than anywhere an avatar is shown; CSS `image-rendering: pixelated`
 * scales it further for free.
 */
export const MAX_AVATAR_SCALE = 16;

export const AVATAR_BACKGROUNDS = ['color', 'transparent'] as const;
export type AvatarBackgroundParam = (typeof AVATAR_BACKGROUNDS)[number];

/**
 * Not `immutable`, although a code is the character: a vendor bump that
 * redraws art changes the PNG a code draws (pixatar's pinned snapshots may
 * change on such a bump). A day of freshness and a week of stale-while-
 * revalidate keep repeat views free, and the ETag makes the revalidation a 304.
 */
export const AVATAR_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';

const SEED_CODE_RE = /^px\.[A-Za-z0-9_-]+$/;

export interface RenderedAvatar {
  png: Buffer;
  /** A strong ETag over the exact bytes. */
  etag: string;
}

/**
 * Least-recently-used, bounded by entry count. An entry is a few kilobytes at
 * most (a 320×320 avatar is ~2 KB of PNG), so 1000 of them is a couple of
 * megabytes, and a page of authors re-asking for theirs costs no render.
 */
const CACHE_ENTRIES = 1000;
const cache = new Map<string, RenderedAvatar>();

/** Exported for tests. */
export function clearAvatarCache(): void {
  cache.clear();
}

/** Throws the API's own error for anything that is not a drawable seed code. */
export function assertSeedCode(seed: string): void {
  if (!isSeedCode(seed)) {
    throw new ApiError(
      400,
      'invalid_seed',
      'Only seed codes (px. followed by base64url) are drawn here, never free text. ' +
        'Make the code from the text where it is typed (seedFromText in @pixel-index/pixatar) and ask for that.',
    );
  }
  if (seed.length > MAX_SEED_CODE_LENGTH) {
    throw new ApiError(400, 'invalid_seed', `A seed code drawn here is at most ${MAX_SEED_CODE_LENGTH} characters.`);
  }
  if (!SEED_CODE_RE.test(seed)) {
    throw new ApiError(400, 'invalid_seed', 'A seed code is px. followed by base64url (A–Z, a–z, 0–9, - and _).');
  }
}

export function renderAvatarPng(
  seed: string,
  { scale, background }: { scale: number; background?: AvatarBackgroundParam },
): RenderedAvatar {
  assertSeedCode(seed);
  const key = `${seed}|${scale}|${background ?? ''}`;
  const hit = cache.get(key);
  if (hit) {
    // Re-insert: a Map iterates in insertion order, so the first key is the
    // least recently used one.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  let png: Buffer;
  try {
    const character = pixatar(seed, background ? { background } : {});
    png = Buffer.from(character.avatarPng({ scale }));
  } catch (error) {
    if (error instanceof PixatarError) {
      if (error.code === 'unknown-part') {
        // A valid code made with a wardrobe that has more parts than this
        // deployment's pin: not the caller's typo, and a vendor bump may draw it.
        throw new ApiError(422, 'unknown_part', error.message);
      }
      throw new ApiError(400, 'invalid_seed', error.message);
    }
    throw error;
  }

  const rendered = { png, etag: `"${createHash('sha256').update(png).digest('base64url')}"` };
  cache.set(key, rendered);
  if (cache.size > CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return rendered;
}

/** The pinned Pixel Agents commit the avatars are drawn with, for a client keying its own cache. */
export const AVATAR_VENDOR_COMMIT = VENDOR.commit;

const AVATAR_PATH_RE = /^(\/api\/v1\/avatars\/)([^?]*)(.*)$/;

/**
 * The request URL as logged. Free text is refused, but the request asking for
 * it still arrives and would be logged verbatim: anything under the avatar path
 * that is not a well-formed seed code is replaced, so an email address someone
 * pasted as a seed stops here rather than in this service's logs. (A reverse
 * proxy in front keeps its own logs; see docs/deployment.md.)
 */
export function redactAvatarUrl(url: string): string {
  const match = AVATAR_PATH_RE.exec(url);
  if (!match) return url;
  const [, prefix = '', segment = '', rest = ''] = match;
  const seed = segment.endsWith('.png') ? segment.slice(0, -'.png'.length) : segment;
  if (seed.length <= MAX_SEED_CODE_LENGTH && SEED_CODE_RE.test(seed)) return url;
  return `${prefix}[redacted]${rest}`;
}
