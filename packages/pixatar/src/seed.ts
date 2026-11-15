/**
 * Seeds. There are two kinds: a seed code (`px.` + base64url) and free text.
 *
 * A seed code IS a character profile, written compactly: decoding it gives the profile back
 * exactly, and a changed profile gets a changed code (the song-code idea from Pixel Agents'
 * radio: the code is the tune, nothing else is stored). It also says whether the avatar sits
 * on its background colour or on nothing, so a code describes the whole avatar export.
 *
 * Free text is any string at all, of any length. Its SHA-256 drives upstream's own
 * randomizer (in counter mode: every draw is fresh hash output), so the same text always
 * makes the same character, and changing any one character of it deals a new one from
 * scratch. A text seed generates a seed code, and is drawn through that code (for a given
 * wardrobe: a vendor bump that adds parts may re-deal text seeds, never codes).
 *
 * The format byte: its low nibble is the format, and TRANSPARENT (0x10) marks a code whose
 * avatar has a transparent background. Codes made before the flag existed don't have it,
 * so they keep the coloured background they always had.
 *
 * Code bytes, after the format byte:
 *   1 (compact): profile version, eye flags (eye shape present | eye rows << 1), eye shape,
 *     a bit mask of worn slots (SLOT_ORDER), each worn part, then the colours: their count,
 *     and per colour its key (COLOR_KEY_ORDER), a flags byte (colorize, palette, then which
 *     of h, s, b, c are non-zero, and whether they are small), the colourway, and the non-zero
 *     sliders: when small, h as a varint and s, b, c a signed byte each, else zigzag varints.
 *     Part ids, eye shapes and colourway names are 16-bit hashes, looked up in the wardrobe,
 *     so a part keeps its code however many parts later themes add around it.
 *   2 (packed): the canonical profile as deflated JSON. Used whenever compact can't say
 *     the profile exactly (pixel edits, fields or parts the compact tables don't know).
 * Every compact code is decoded again before it is handed out, and falls back to packed if
 * it doesn't give the same profile, so a code always round-trips.
 */

import { deflateSync, inflateSync } from 'fflate';

import { fnv1a32, fromBase64Url, fromUtf8, sha256, toBase64Url, utf8 } from './bytes.js';
import { canonicalProfile, sameProfile } from './canonical.js';
import { PixatarError } from './errors.js';
import { type CharacterColor, type CharacterProfile, EYE_SHAPES, newProfile, randomize, rng, UNDERWEAR } from './vendor.js';
import { getRenderer, getWardrobe } from './wardrobe.js';

/** What every seed code starts with. Text that starts with it must be a valid code. */
export const SEED_PREFIX = 'px.';

const COMPACT = 1;
const PACKED = 2;
/** Format byte flag: the avatar's background is transparent (absent: its colour). */
const TRANSPARENT = 0x10;

/** What an avatar is drawn on: its background colour (the default), or nothing. */
export type AvatarBackground = 'color' | 'transparent';

export interface SeedOptions {
  /** The avatar's background (default 'color'). The sprite sheet is always transparent. */
  background?: AvatarBackground;
}

/** Everything a seed code says: the character, and how its avatar is exported. */
export interface SeedContents {
  profile: CharacterProfile;
  background: AvatarBackground;
}

/**
 * The compact format's tables. Append-only: a code names entries by their place here, so
 * reordering one breaks every code already handed out. A slot or colour key upstream adds
 * that isn't here yet still round-trips (packed); seed.test.ts says when to append it.
 */
export const SLOT_ORDER = [
  'body', 'utop', 'under', 'hair', 'beard', 'top', 'jacket', 'pants', 'shoes', 'full', 'hat',
  'necklace', 'lanyard', 'earrings', 'shades', 'hairshades', 'watch',
] as const;
export const COLOR_KEY_ORDER = [
  'skin', 'eyes', 'lashes', 'tie', 'utop', 'under', 'hair', 'beard', 'top', 'jacket', 'pants',
  'shoes', 'full', 'hat', 'necklace', 'lanyard', 'earrings', 'shades', 'hairshades', 'watch',
] as const;
const EYE_ROWS_ORDER = [undefined, 'top', 'bottom', 'both'] as const;
const COLOR_FIELDS = new Set(['h', 's', 'b', 'c', 'colorize', 'palette']);
const SLIDERS = ['h', 's', 'b', 'c'] as const;
/** Colour flag: h as an unsigned varint, s, b and c one signed byte each (the sliders' usual range). */
const SMALL = 64;
const isSmall = (cv: CharacterColor) =>
  cv.h >= 0 && ['s', 'b', 'c'].every((k) => cv[k as 's'] >= -128 && cv[k as 's'] <= 127);
const COMPACT_FIELDS = new Set<string>(['v', 'eyeShape', 'eyeRows', 'colors', ...SLOT_ORDER]);

const hash16 = (id: string) => fnv1a32(id) & 0xffff;

/** Ids by their 16-bit hash; an id sharing its hash with another isn't in it (packed only). */
class Dictionary {
  private readonly byHash = new Map<number, string | null>();

  constructor(ids: Iterable<string>) {
    for (const id of new Set(ids)) {
      const h = hash16(id);
      this.byHash.set(h, this.byHash.has(h) ? null : id);
    }
  }

  hashOf(id: string): number | null {
    const h = hash16(id);
    return this.byHash.get(h) === id ? h : null;
  }

  idOf(h: number): string | null {
    return this.byHash.get(h) ?? null;
  }
}

interface Dictionaries {
  slots: Map<string, Dictionary>;
  eyeShapes: Dictionary;
  palettes: Dictionary;
}
let dictionaries: Dictionaries | null = null;

function getDictionaries(): Dictionaries {
  if (dictionaries) return dictionaries;
  const { manifest } = getWardrobe();
  const slots = new Map<string, Dictionary>();
  for (const slot of SLOT_ORDER) {
    const ids = (manifest.parts[slot] ?? []).map((p) => p.id);
    // underwear isn't a wardrobe category: each body draws its own, worn as UNDERWEAR
    if (slot === 'under' || slot === 'utop') ids.push(UNDERWEAR);
    slots.set(slot, new Dictionary(ids));
  }
  const palettes = new Set<string>();
  for (const parts of Object.values(manifest.parts)) {
    for (const part of parts) for (const name of Object.keys(part.swaps ?? {})) palettes.add(name);
  }
  for (const palette of Object.values(manifest.palettes)) {
    for (const row of Object.values(palette.values)) for (const cv of row) if (cv.palette) palettes.add(cv.palette);
  }
  dictionaries = { slots, eyeShapes: new Dictionary(EYE_SHAPES.map((e) => e.id)), palettes: new Dictionary(palettes) };
  return dictionaries;
}

class Writer {
  private readonly out: number[] = [];

  byte(b: number): void {
    this.out.push(b & 0xff);
  }

  uint(n: number): void {
    let rest = n;
    while (rest >= 0x80) {
      this.out.push((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.out.push(rest);
  }

  int(n: number): void {
    this.uint(n < 0 ? -2 * n - 1 : 2 * n);
  }

  u16(n: number): void {
    this.out.push(n >> 8, n & 0xff);
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

const truncated = () => new PixatarError('invalid-seed', 'This seed code is cut short.');

class Reader {
  private at = 0;

  constructor(private readonly data: Uint8Array) {}

  byte(): number {
    if (this.at >= this.data.length) throw truncated();
    return this.data[this.at++];
  }

  uint(): number {
    let n = 0;
    for (let scale = 1; ; scale *= 0x80) {
      const b = this.byte();
      n += (b & 0x7f) * scale;
      if (b < 0x80) return n;
      if (scale > 2 ** 42) throw new PixatarError('invalid-seed', 'This seed code holds a number too large.');
    }
  }

  int(): number {
    const z = this.uint();
    return z % 2 ? -(z + 1) / 2 : z / 2;
  }

  u16(): number {
    return (this.byte() << 8) | this.byte();
  }

  done(): boolean {
    return this.at === this.data.length;
  }
}

/** The compact bytes of a canonical profile, or null when compact can't say it. */
function encodeCompact(p: CharacterProfile): Uint8Array | null {
  const fields = p as unknown as Record<string, unknown>;
  if (!Object.keys(fields).every((k) => COMPACT_FIELDS.has(k))) return null;
  const d = getDictionaries();
  const w = new Writer();
  w.byte(COMPACT);
  const { v } = p;
  if (v === undefined || !Number.isSafeInteger(v) || v < 0) return null;
  w.uint(v);
  const rows = EYE_ROWS_ORDER.indexOf(p.eyeRows);
  if (rows < 0) return null;
  w.uint((p.eyeShape !== undefined ? 1 : 0) | (rows << 1));
  if (p.eyeShape !== undefined) {
    const h = d.eyeShapes.hashOf(p.eyeShape);
    if (h === null) return null;
    w.u16(h);
  }
  const worn = SLOT_ORDER.filter((slot) => fields[slot] !== undefined);
  w.uint(worn.reduce((mask, slot) => mask + 2 ** SLOT_ORDER.indexOf(slot), 0));
  for (const slot of worn) {
    const h = d.slots.get(slot)?.hashOf(fields[slot] as string) ?? null;
    if (h === null) return null;
    w.u16(h);
  }
  const colors = Object.entries(p.colors ?? {});
  w.uint(colors.length);
  for (const [key, cv] of colors) {
    const index = COLOR_KEY_ORDER.indexOf(key as (typeof COLOR_KEY_ORDER)[number]);
    if (index < 0 || !Object.keys(cv).every((k) => COLOR_FIELDS.has(k))) return null;
    if (!SLIDERS.every((k) => Number.isSafeInteger(cv[k]))) return null;
    w.uint(index);
    const small = isSmall(cv);
    let flags = (cv.colorize ? 1 : 0) | (cv.palette !== undefined ? 2 : 0) | (small ? SMALL : 0);
    SLIDERS.forEach((k, i) => {
      if (cv[k] !== 0) flags |= 4 << i;
    });
    w.byte(flags);
    if (cv.palette !== undefined) {
      const h = d.palettes.hashOf(cv.palette);
      if (h === null) return null;
      w.u16(h);
    }
    for (const k of SLIDERS) {
      if (cv[k] === 0) continue;
      if (!small) w.int(cv[k]);
      else if (k === 'h') w.uint(cv.h);
      else w.byte(cv[k]);
    }
  }
  return w.bytes();
}

function unknownPart(what: string): PixatarError {
  return new PixatarError(
    'unknown-part',
    `This seed code names a ${what} this version of the wardrobe doesn't have (made by a newer version?).`,
  );
}

function found(id: string | null, what: string): string {
  if (id === null) throw unknownPart(what);
  return id;
}

function decodeCompact(r: Reader): Record<string, unknown> {
  const d = getDictionaries();
  const p: Record<string, unknown> = { v: r.uint() };
  const eye = r.uint();
  if (eye > 7) throw new PixatarError('invalid-seed', 'This seed code has unknown eye flags.');
  const rows = EYE_ROWS_ORDER[eye >> 1];
  if (rows !== undefined) p.eyeRows = rows;
  if (eye & 1) p.eyeShape = found(d.eyeShapes.idOf(r.u16()), 'eye shape');
  let mask = r.uint();
  if (mask >= 2 ** SLOT_ORDER.length) throw unknownPart('slot');
  for (const slot of SLOT_ORDER) {
    if (mask % 2) p[slot] = found(d.slots.get(slot)?.idOf(r.u16()) ?? null, `${slot} part`);
    mask = Math.floor(mask / 2);
  }
  const count = r.uint();
  if (count > COLOR_KEY_ORDER.length) throw new PixatarError('invalid-seed', 'This seed code holds too many colours.');
  const colors: Record<string, CharacterColor> = {};
  for (let i = 0; i < count; i++) {
    const key = COLOR_KEY_ORDER.at(r.uint());
    if (!key) throw unknownPart('colour');
    const flags = r.byte();
    if (flags >= 128) throw new PixatarError('invalid-seed', 'This seed code has unknown colour flags.');
    const cv: CharacterColor = { h: 0, s: 0, b: 0, c: 0 };
    if (flags & 1) cv.colorize = true;
    if (flags & 2) cv.palette = found(d.palettes.idOf(r.u16()), 'colourway');
    SLIDERS.forEach((k, j) => {
      if (!(flags & (4 << j))) return;
      if (!(flags & SMALL)) cv[k] = r.int();
      else if (k === 'h') cv.h = r.uint();
      else cv[k] = (r.byte() << 24) >> 24;
    });
    colors[key] = cv;
  }
  if (count) p.colors = colors;
  if (!r.done()) throw new PixatarError('invalid-seed', 'This seed code has bytes past its end.');
  return p;
}

function packed(p: CharacterProfile): Uint8Array {
  const body = deflateSync(utf8(JSON.stringify(p)), { level: 9 });
  const out = new Uint8Array(body.length + 1);
  out[0] = PACKED;
  out.set(body, 1);
  return out;
}

function profileBytes(p: CharacterProfile): Uint8Array {
  const compact = encodeCompact(p);
  if (compact) {
    try {
      if (sameProfile(canonicalProfile(decodeCompact(new Reader(compact.subarray(1)))), p)) return compact;
    } catch {
      // not representable after all: packed below
    }
  }
  return packed(p);
}

/**
 * The seed code of a profile: the same for every profile that canonicalises alike. With the
 * default (coloured) background it is the code pixatar has always made for that profile.
 */
export function seedFromProfile(profile: unknown, options: SeedOptions = {}): string {
  // unknown: a JavaScript caller can pass anything
  const background: unknown = options.background ?? 'color';
  if (background !== 'color' && background !== 'transparent') {
    throw new RangeError(`background must be 'color' or 'transparent', not ${String(background)}`);
  }
  const bytes = profileBytes(canonicalProfile(profile));
  if (background === 'transparent') bytes[0] |= TRANSPARENT;
  return SEED_PREFIX + toBase64Url(bytes);
}

export const isSeedCode = (seed: string): boolean => seed.startsWith(SEED_PREFIX);

/** Everything a seed code holds. Throws a PixatarError when it isn't one. */
export function decodeSeedCode(code: string): SeedContents {
  const bytes = isSeedCode(code) ? fromBase64Url(code.slice(SEED_PREFIX.length)) : null;
  if (!bytes?.length) throw new PixatarError('invalid-seed', `A seed code is ${SEED_PREFIX} followed by base64url.`);
  const background: AvatarBackground = bytes[0] & TRANSPARENT ? 'transparent' : 'color';
  const r = new Reader(bytes.subarray(1));
  switch (bytes[0] & ~TRANSPARENT) {
    case COMPACT:
      return { profile: canonicalProfile(decodeCompact(r)), background };
    case PACKED: {
      let json: unknown;
      try {
        json = JSON.parse(fromUtf8(inflateSync(bytes.subarray(1))));
      } catch {
        throw new PixatarError('invalid-seed', 'This seed code is damaged.');
      }
      return { profile: canonicalProfile(json), background };
    }
    default:
      throw new PixatarError('invalid-seed', 'This seed code is in a format this version does not know.');
  }
}

/** The profile a seed code holds. Throws a PixatarError when it isn't one. */
export const profileFromCode = (code: string): CharacterProfile => decodeSeedCode(code).profile;

/** The character upstream's randomizer deals from a stream of numbers in [0, 1). */
function dealt(random: () => number): CharacterProfile {
  const profile = newProfile();
  // upstream's randomize() draws from Math.random: lend it the seeded stream for the one
  // synchronous call (nothing else can run in between)
  const original = Math.random;
  Math.random = random;
  try {
    randomize(getRenderer(), profile);
  } finally {
    Math.random = original;
  }
  return canonicalProfile(profile);
}

/**
 * Numbers in [0, 1) from a text's SHA-256, in counter mode: draw i is 32 bits of
 * SHA-256(SHA-256(text) || i), so every draw depends on every byte of the text.
 */
function textStream(text: string): () => number {
  const key = sha256(text);
  const input = new Uint8Array(key.length + 4);
  input.set(key);
  const counter = new DataView(input.buffer, key.length);
  let block: Uint8Array = new Uint8Array(0);
  let at = 0;
  let n = 0;
  return () => {
    if (at === block.length) {
      counter.setUint32(0, n++);
      block = sha256(input);
      at = 0;
    }
    const word = ((block[at] << 24) | (block[at + 1] << 16) | (block[at + 2] << 8) | block[at + 3]) >>> 0;
    at += 4;
    return word / 2 ** 32;
  };
}

/**
 * The character a free-text seed makes: any string, of any length (a string starting with
 * `px.` too: here it is only text). One changed character deals a whole new character.
 */
export const profileFromText = (text: string): CharacterProfile => dealt(textStream(text));

/** The seed code a free-text seed generates. */
export const seedFromText = (text: string, options?: SeedOptions): string =>
  seedFromProfile(profileFromText(text), options);

/**
 * What any seed says: a seed code's own contents, or the character text makes (on its
 * background colour). A string starting with `px.` is read as a code; use seedFromText for
 * text that happens to.
 */
export const decodeSeed = (seed: string): SeedContents =>
  isSeedCode(seed) ? decodeSeedCode(seed) : { profile: profileFromText(seed), background: 'color' };

/** The profile any seed stands for: a seed code's own, or the one its text makes. */
export const profileFromSeed = (seed: string): CharacterProfile => decodeSeed(seed).profile;

/** Any seed as its seed code (a code comes back as the canonical code of its contents). */
export function normalizeSeed(seed: string): string {
  const { profile, background } = decodeSeed(seed);
  return seedFromProfile(profile, { background });
}

/** A new random character's seed code. */
export function randomSeed(options?: SeedOptions): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0];
  return seedFromProfile(dealt(rng(n)), options);
}
