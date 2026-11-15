import { describe, expect, it } from 'vitest';

import { fnv1a32, fromBase64Url } from '../src/bytes.js';
import {
  type CharacterProfile,
  isSeedCode,
  normalizeSeed,
  PixatarError,
  profileFromCode,
  profileFromSeed,
  profileFromText,
  randomSeed,
  SEED_PREFIX,
  seedFromProfile,
} from '../src/index.js';
import { COLOR_KEY_ORDER, SLOT_ORDER } from '../src/seed.js';
import { CHARACTER_SLOTS, EYE_SHAPES, LAYERS } from '../src/vendor.js';
import { getWardrobe } from '../src/wardrobe.js';

const TEXTS = Array.from({ length: 400 }, (_, i) => `seed ${i}`).concat(['', 'octocat', 'nntin', '🎃', 'a'.repeat(500)]);

/** The format byte of a seed code. */
function formatOf(code: string): number {
  const bytes = fromBase64Url(code.slice(SEED_PREFIX.length));
  if (!bytes) throw new Error(`Not a seed code: ${code}`);
  return bytes[0];
}

function invalid(code: string) {
  try {
    profileFromCode(code);
  } catch (error) {
    return error instanceof PixatarError ? error.code : String(error);
  }
  return 'decoded';
}

describe('text seeds', () => {
  it('make the same character every time', () => {
    for (const text of ['octocat', 'nntin', '']) {
      expect(profileFromText(text)).toEqual(profileFromText(text));
      expect(seedFromProfile(profileFromText(text))).toBe(seedFromProfile(profileFromText(text)));
    }
  });

  it('make different characters for different text', () => {
    const codes = new Set(TEXTS.map((t) => normalizeSeed(t)));
    expect(codes.size).toBeGreaterThan(TEXTS.length * 0.98);
  });

  it('are pinned for this wardrobe (a vendor bump that re-deals them shows here)', () => {
    expect(['octocat', 'nntin', 'pixel agents'].map(normalizeSeed)).toMatchSnapshot();
  });
});

describe('seed codes', () => {
  it('give back exactly the profile they were made from, compactly', () => {
    for (const text of TEXTS) {
      const profile = profileFromText(text);
      const code = seedFromProfile(profile);
      expect(isSeedCode(code)).toBe(true);
      expect(formatOf(code), text).toBe(1);
      expect(code.length).toBeLessThan(120);
      expect(profileFromCode(code)).toEqual(profile);
      expect(profileFromSeed(code)).toEqual(profile);
      expect(normalizeSeed(code)).toBe(code);
    }
  });

  it('change when the character changes, and change back', () => {
    const profile = profileFromText('octocat');
    const code = seedFromProfile(profile);
    const hats = getWardrobe().manifest.parts.hat.map((p) => p.id);
    const hatted = seedFromProfile({ ...profile, hat: hats[0] });
    expect(hatted).not.toBe(code);
    expect(profileFromCode(hatted).hat).toBe(hats[0]);
    const recoloured = seedFromProfile({ ...profile, colors: { ...profile.colors, eyes: { h: 120, s: 40, b: -3, c: 7, colorize: true } } });
    expect(recoloured).not.toBe(code);
    expect(seedFromProfile({ ...profileFromCode(hatted), hat: profile.hat })).toBe(code);
  });

  it('ignore what names a copy rather than describes a look', () => {
    const profile = profileFromText('octocat');
    const code = seedFromProfile(profile);
    expect(seedFromProfile({ ...profile, id: 'c-abc123', name: 'Octo' })).toBe(code);
    const colors = Object.fromEntries(Object.entries(profile.colors ?? {}).map(([k, cv]) => [k, { ...cv, colorize: cv.colorize ?? false }]));
    expect(seedFromProfile({ ...profile, colors })).toBe(code);
  });

  it('carry pixel edits and unknown fields too (packed)', () => {
    const profile: CharacterProfile = {
      ...profileFromText('octocat'),
      edits: { [`hair:${profileFromText('octocat').hair ?? 'bob'}`]: { cells: { 0: { 17: '#ff00aa', 18: null } } } },
    };
    const code = seedFromProfile(profile);
    expect(formatOf(code)).toBe(2);
    expect(seedFromProfile(profileFromCode(code))).toBe(code);
    expect(profileFromCode(code).edits).toEqual(profile.edits);

    const future = { ...profileFromText('nntin'), aura: 'spooky' } as CharacterProfile;
    const futureCode = seedFromProfile(future);
    expect(formatOf(futureCode)).toBe(2);
    expect((profileFromCode(futureCode) as unknown as { aura: string }).aura).toBe('spooky');
  });

  it('refuse what is not a seed code', () => {
    const good = seedFromProfile(profileFromText('octocat'));
    expect(invalid('px.')).toBe('invalid-seed');
    expect(invalid('px.!!!!')).toBe('invalid-seed');
    expect(invalid('px.CQ')).toBe('invalid-seed'); // format 9
    expect(invalid(good.slice(0, -3))).toBe('invalid-seed');
    expect(invalid(`${good}AAAA`)).toBe('invalid-seed');
    expect(invalid('px.Ah8')).toBe('invalid-seed'); // packed, not deflate
    expect(() => profileFromSeed('px.nope!')).toThrow(PixatarError);
  });

  it('report a part this wardrobe does not have', () => {
    // compact, version 35, no eye shape, one slot (body), hash 0xffff
    const bytes = Uint8Array.of(1, 35, 0, 1, 0xff, 0xff, 0);
    const code = SEED_PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(invalid(code)).toBe('unknown-part');
  });

  it('random seeds are seed codes of new characters', () => {
    const a = randomSeed();
    expect(isSeedCode(a)).toBe(true);
    expect(normalizeSeed(a)).toBe(a);
  });
});

describe("the compact tables keep up with the pinned upstream", () => {
  it('name every character slot (append a new one to SLOT_ORDER)', () => {
    expect(SLOT_ORDER).toEqual(expect.arrayContaining([...CHARACTER_SLOTS]));
  });

  it('name every colour key (append a new one to COLOR_KEY_ORDER)', () => {
    const keys = new Set<string>(['tie']);
    for (const layer of LAYERS) if (layer.color) keys.add(layer.color);
    expect(COLOR_KEY_ORDER).toEqual(expect.arrayContaining([...keys]));
  });

  it('hash every part, eye shape and colourway apart (a clash would make its codes packed)', () => {
    const { manifest } = getWardrobe();
    const unique = (ids: string[]) => new Set(ids.map((id) => fnv1a32(id) & 0xffff)).size === new Set(ids).size;
    for (const [slot, parts] of Object.entries(manifest.parts)) expect(unique(parts.map((p) => p.id)), slot).toBe(true);
    expect(unique(EYE_SHAPES.map((e) => e.id))).toBe(true);
    const palettes = new Set<string>();
    for (const parts of Object.values(manifest.parts)) for (const p of parts) for (const n of Object.keys(p.swaps ?? {})) palettes.add(n);
    for (const pal of Object.values(manifest.palettes)) for (const row of Object.values(pal.values)) for (const cv of row) if (cv.palette) palettes.add(cv.palette);
    expect(unique([...palettes])).toBe(true);
  });

  it('wear every wardrobe part compactly', () => {
    const base = profileFromText('octocat');
    for (const slot of SLOT_ORDER) {
      for (const part of getWardrobe().manifest.parts[slot] ?? []) {
        const code = seedFromProfile({ ...base, [slot]: part.id });
        expect(formatOf(code), `${slot}:${part.id}`).toBe(1);
      }
    }
  });
});
