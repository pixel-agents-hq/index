/**
 * What the CLI answers, one request at a time: `pixatar serve` reads these as JSON lines
 * (the Python client's transport) and the one-shot commands are the same requests. Kept apart
 * from the CLI's I/O so the tests can drive it directly.
 */

import pkg from '../package.json' with { type: 'json' };
import { toBase64 } from './bytes.js';
import { PixatarError } from './errors.js';
import { VENDOR } from './generated/wardrobe.js';
import { pixatar } from './index.js';
import { type AvatarBackground, seedFromText } from './seed.js';

export const OPS = ['avatar', 'sheet', 'info', 'version'] as const;
export type Op = (typeof OPS)[number];

export interface Request {
  /** Echoed back on the response, so a client can match the two. */
  id?: unknown;
  op: Op;
  /** A seed code, or free text (a string starting with px. is read as a code unless `text`). */
  seed?: string;
  /** Read `seed` as free text even when it starts with px. */
  text?: boolean;
  /** Output pixels per sprite pixel, 1 to 64 (avatar and sheet). */
  scale?: number;
  /** Overrides what the seed says about the avatar's background. */
  background?: AvatarBackground;
}

/** PixatarError's codes, a malformed request, or a bug in pixatar (its message says what). */
export type ErrorCode = PixatarError['code'] | 'invalid-request' | 'internal-error';

export type Response =
  | ({ id: unknown; ok: true } & Record<string, unknown>)
  | { id: unknown; ok: false; error: { code: ErrorCode; message: string } };

const invalid = (message: string) => ({ code: 'invalid-request' as const, message });

/** The request's fields checked, or what's wrong with it. */
function check(request: unknown): Request | { code: 'invalid-request'; message: string } {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return invalid('A request is a JSON object.');
  const r = request as Record<string, unknown>;
  if (!OPS.includes(r.op as Op)) return invalid(`op must be one of ${OPS.join(', ')}.`);
  if (r.op !== 'version' && typeof r.seed !== 'string') return invalid('seed must be a string.');
  if (r.text !== undefined && typeof r.text !== 'boolean') return invalid('text must be true or false.');
  if (r.scale !== undefined && typeof r.scale !== 'number') return invalid('scale must be a number.');
  if (r.background !== undefined && r.background !== 'color' && r.background !== 'transparent') {
    return invalid("background must be 'color' or 'transparent'.");
  }
  return r as unknown as Request;
}

function answer(r: Request): Record<string, unknown> {
  if (r.op === 'version') return { version: pkg.version, vendor: VENDOR };
  // check() made sure every op but version has one
  if (r.seed === undefined) throw new TypeError('seed must be a string.');
  const seed = r.text ? seedFromText(r.seed) : r.seed;
  const character = pixatar(seed, { background: r.background });
  const about = { seed: character.seed, background: character.background, avatarBackground: character.avatarBackground };
  switch (r.op) {
    case 'avatar':
      return { ...about, png: toBase64(character.avatarPng({ scale: r.scale })) };
    case 'sheet':
      return { ...about, png: toBase64(character.sheetPng({ scale: r.scale })) };
    case 'info':
      return { ...about, profile: character.profile };
  }
}

/** One request's response. Never throws: a bad seed or request is an error response. */
export function handle(request: unknown): Response {
  const id = (request as { id?: unknown } | null)?.id ?? null;
  const r = check(request);
  if (!('op' in r)) return { id, ok: false, error: r };
  try {
    return { id, ok: true, ...answer(r) };
  } catch (e) {
    if (e instanceof PixatarError) return { id, ok: false, error: { code: e.code, message: e.message } };
    if (e instanceof RangeError || e instanceof TypeError) return { id, ok: false, error: invalid(e.message) };
    return { id, ok: false, error: { code: 'internal-error', message: String(e) } };
  }
}
