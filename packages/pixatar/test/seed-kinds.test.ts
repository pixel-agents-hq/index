import { createHash } from 'node:crypto';

import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { fromBase64Url, sha256 } from '../src/bytes.js';
import {
  backgroundColor,
  type CharacterProfile,
  decodeSeed,
  decodeSeedCode,
  normalizeSeed,
  pixatar,
  PixatarError,
  profileFromCode,
  profileFromText,
  renderSheet,
  SEED_PREFIX,
  seedFromProfile,
  seedFromText,
} from '../src/index.js';
import legacy from './fixtures/legacy-seeds.json' with { type: 'json' };

const md5 = (data: Uint8Array | Uint8ClampedArray) => createHash('md5').update(data).digest('hex');
/** A seed code's bytes, after its px. prefix. */
function codeBytes(code: string): Uint8Array {
  const bytes = fromBase64Url(code.slice(SEED_PREFIX.length));
  if (!bytes) throw new Error(`Not a seed code: ${code}`);
  return bytes;
}
const formatByte = (code: string) => codeBytes(code)[0];

/** The traits two profiles differ in: every slot, eye field and colour, compared one by one. */
function traitsChanged(a: CharacterProfile, b: CharacterProfile): number {
  const flat = (p: CharacterProfile) => {
    const { colors = {}, ...rest } = p;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(rest)) out[k] = JSON.stringify(v);
    for (const [k, v] of Object.entries(colors)) out[`colors.${k}`] = JSON.stringify(v);
    return out;
  };
  const fa = flat(a);
  const fb = flat(b);
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  keys.delete('v');
  let changed = 0;
  for (const k of keys) if (fa[k] !== fb[k]) changed++;
  return changed / keys.size;
}

describe('sha256', () => {
  it('matches node:crypto at every padding edge', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
      const text = 'é'.repeat(n).slice(0, n);
      expect(Buffer.from(sha256(text)).toString('hex'), String(n)).toBe(createHash('sha256').update(text).digest('hex'));
    }
  });
});

describe('existing seed codes', () => {
  it('decode to exactly the character they always did, on its background colour', () => {
    for (const { code, profile, background, sheet } of legacy) {
      expect(profileFromCode(code)).toEqual(profile);
      expect(decodeSeedCode(code).background).toBe('color');
      expect(backgroundColor(code)).toBe(background);
      expect(md5(renderSheet(profileFromCode(code)).data)).toBe(sheet);
      expect(normalizeSeed(code)).toBe(code);
      expect(seedFromProfile(profile)).toBe(code);
      const character = pixatar(code);
      expect([character.seed, character.background, character.avatarBackground]).toEqual([code, background, 'color']);
      // the avatar sits on its colour, opaque all over
      const avatar = character.avatar();
      expect(avatar.data.filter((_, i) => i % 4 === 3).every((a) => a === 255)).toBe(true);
    }
  });
});

describe('free-text seeds', () => {
  const BASES = ['octocat', 'nntin', 'pixel agents', 'a', 'Hello, World!', '🎃 spooky', 'x'.repeat(300)];

  it('take any string, of any length, and make the same code every time', () => {
    const texts = ['', ' ', 'px.', 'px.not a code at all', '\u0000￿', '🎃'.repeat(5000), 'z'.repeat(200_000)];
    for (const text of texts) {
      const code = seedFromText(text);
      expect(code).toBe(seedFromText(text));
      expect(formatByte(code)).toBe(1);
      expect(profileFromCode(code)).toEqual(profileFromText(text));
    }
  });

  it('generate a seed code, and draw through it', () => {
    const code = seedFromText('octocat');
    expect(normalizeSeed('octocat')).toBe(code);
    expect(decodeSeed('octocat')).toEqual(decodeSeedCode(code));
    expect(pixatar('octocat').seed).toBe(code);
    expect(md5(pixatar('octocat').sheet().data)).toBe(md5(pixatar(code).sheet().data));
  });

  it('change completely when any one character changes', () => {
    const random: number[] = [];
    for (let i = 0; i < BASES.length; i++) random.push(traitsChanged(profileFromText(BASES[i]), profileFromText(BASES[(i + 1) % BASES.length])));
    const flips: number[] = [];
    for (const base of BASES) {
      const before = profileFromText(base);
      for (const at of new Set([0, Math.floor(base.length / 2), base.length - 1])) {
        if (at < 0) continue;
        const cp = base.codePointAt(at);
        if (cp === undefined) throw new Error(`No character at ${at} of ${base}`);
        const flipped = base.slice(0, at) + String.fromCodePoint(cp ^ 1) + base.slice(at + String.fromCodePoint(cp).length);
        expect(seedFromText(flipped), JSON.stringify([base, at])).not.toBe(seedFromText(base));
        flips.push(traitsChanged(before, profileFromText(flipped)));
      }
      // appending or dropping a character (length isn't a trait) re-deals as well
      flips.push(traitsChanged(before, profileFromText(`${base} `)));
      flips.push(traitsChanged(before, profileFromText(base.slice(1))));
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // a one-character change moves about as many traits as two unrelated texts do
    expect(mean(flips)).toBeGreaterThan(0.6);
    expect(mean(flips)).toBeGreaterThan(mean(random) - 0.15);
    expect(Math.min(...flips)).toBeGreaterThan(0.3);
  });

  it('do not let length decide the character', () => {
    // texts of one length don't share traits more than texts of different lengths
    const same = Array.from({ length: 60 }, (_, i) => profileFromText(`seed-${String(i).padStart(3, '0')}`));
    const bodies = new Set(same.map((p) => JSON.stringify([p.body, p.hair, p.top])));
    expect(bodies.size).toBeGreaterThan(50);
    const lengths = Array.from({ length: 40 }, (_, n) => seedFromText('q'.repeat(n)));
    expect(new Set(lengths).size).toBe(lengths.length);
  });

  it('read px. as text when asked to', () => {
    expect(() => decodeSeed('px.hello')).toThrow(PixatarError);
    expect(formatByte(seedFromText('px.hello'))).toBe(1);
  });
});

describe('the avatar background flag', () => {
  const profile = profileFromText('octocat');
  const colour = seedFromProfile(profile);
  const clear = seedFromProfile(profile, { background: 'transparent' });

  it('round-trips through the seed code, compact and packed', () => {
    expect(clear).not.toBe(colour);
    expect(decodeSeedCode(clear)).toEqual({ profile, background: 'transparent' });
    expect(decodeSeedCode(colour)).toEqual({ profile, background: 'color' });
    expect(normalizeSeed(clear)).toBe(clear);
    expect(seedFromText('octocat', { background: 'transparent' })).toBe(clear);
    expect(pixatar(clear).seed).toBe(clear);
    expect(pixatar(clear, { background: 'color' }).seed).toBe(colour);
    expect(pixatar(colour, { background: 'transparent' }).seed).toBe(clear);

    const edited: CharacterProfile = { ...profile, edits: { 'hair:bob': { cells: { 0: { 17: '#ff00aa' } } } } };
    const packedClear = seedFromProfile(edited, { background: 'transparent' });
    expect(formatByte(packedClear)).toBe(0x12);
    expect(decodeSeedCode(packedClear)).toEqual({ profile: canonical(edited), background: 'transparent' });
    expect(formatByte(seedFromProfile(edited))).toBe(2);
  });

  it('is only the format byte: the character and its colour stay', () => {
    expect(formatByte(clear)).toBe(formatByte(colour) | 0x10);
    expect(codeBytes(clear).subarray(1)).toEqual(codeBytes(colour).subarray(1));
    expect(backgroundColor(clear)).toBe(backgroundColor(colour));
    expect(pixatar(clear).background).toBe(pixatar(colour).background);
  });

  it('makes a transparent avatar PNG', () => {
    const alphas = (png: Uint8Array) => PNG.sync.read(Buffer.from(png)).data.filter((_, i) => i % 4 === 3);
    expect(alphas(pixatar(colour).avatarPng()).every((a) => a === 255)).toBe(true);
    const clearAlphas = alphas(pixatar(clear).avatarPng({ scale: 4 }));
    expect(clearAlphas.some((a) => a === 0)).toBe(true);
    expect(clearAlphas.some((a) => a === 255)).toBe(true);
  });

  it('rejects flags it does not know', () => {
    for (const first of [0x21, 0x41, 0x81, 0x13 /* format 3 */]) {
      const bytes = codeBytes(colour);
      bytes[0] = first;
      const code = SEED_PREFIX + Buffer.from(bytes).toString('base64url');
      expect(() => profileFromCode(code), first.toString(16)).toThrow(PixatarError);
    }
    expect(() => seedFromProfile(profile, { background: 'blue' as 'color' })).toThrow(RangeError);
  });
});

describe('the sprite sheet', () => {
  it('stays transparent whatever the background flag says', () => {
    const profile = profileFromText('nntin');
    const colour = pixatar(seedFromProfile(profile));
    const clear = pixatar(seedFromProfile(profile, { background: 'transparent' }));
    expect(md5(clear.sheetPng())).toBe(md5(colour.sheetPng()));
    for (const character of [colour, clear]) {
      const sheet = PNG.sync.read(Buffer.from(character.sheetPng()));
      expect(sheet.data[3]).toBe(0); // top-left corner, outside the character
      expect(sheet.data.filter((_, i) => i % 4 === 3).some((a) => a === 0)).toBe(true);
      expect(character.sheet().data.filter((_, i) => i % 4 === 3).some((a) => a === 0)).toBe(true);
    }
  });
});

function canonical(p: CharacterProfile): CharacterProfile {
  return profileFromCode(seedFromProfile(p));
}
