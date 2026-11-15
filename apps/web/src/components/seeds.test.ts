import { profileFromText } from '@pixel-index/pixatar';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { codeOf, latest, lookOf, readSeed, searchOf, seedFromSearch } from './seeds';

// packages/pixatar/test/pinned.test.ts pins these: what the text "octocat" makes at this vendor pin.
const OCTOCAT = 'px.ASMByrHtCcOaAj1fXEBDyipVOErZBwFd2AE_HAZdVTbyDX2JAR3X5AldBTX_Cn2IAR3U-gBCXzgIdbQBurY';
const OCTOCAT_TRANSPARENT = 'px.ESMByrHtCcOaAj1fXEBDyipVOErZBwFd2AE_HAZdVTbyDX2JAR3X5AldBTX_Cn2IAR3U-gBCXzgIdbQBurY';

afterEach(() => {
  vi.useRealTimers();
});

describe('seedFromSearch / searchOf', () => {
  it('reads ?seed= as a seed code and ?text= as free text', () => {
    expect(seedFromSearch(new URLSearchParams({ seed: OCTOCAT }))).toEqual({ kind: 'code', value: OCTOCAT });
    expect(seedFromSearch(new URLSearchParams({ text: 'px.hello' }))).toEqual({ kind: 'text', value: 'px.hello' });
    expect(seedFromSearch(new URLSearchParams({ text: '' }))).toEqual({ kind: 'text', value: '' });
  });

  it('ignores a ?seed= that is not a seed code, and an address with no seed', () => {
    expect(seedFromSearch(new URLSearchParams({ seed: 'octocat' }))).toBeNull();
    expect(seedFromSearch(new URLSearchParams({ from: 'NIGHT_OWL' }))).toBeNull();
  });

  it('round-trips both kinds through the address', () => {
    for (const seed of [{ kind: 'code', value: OCTOCAT }, { kind: 'text', value: 'a b&c=d' }] as const) {
      expect(seedFromSearch(new URLSearchParams(searchOf(seed).toString()))).toEqual(seed);
    }
  });
});

describe('readSeed / codeOf', () => {
  it('makes the same character from a text and from the code it makes', () => {
    expect(codeOf({ kind: 'text', value: 'octocat' }, 'color')).toBe(OCTOCAT);
    expect(readSeed({ kind: 'code', value: OCTOCAT }).profile).toEqual(readSeed({ kind: 'text', value: 'octocat' }).profile);
  });

  it('takes a text’s background from the toggle, and a code’s from the code', () => {
    expect(readSeed({ kind: 'text', value: 'octocat' }).background).toBeNull();
    expect(codeOf({ kind: 'text', value: 'octocat' }, 'transparent')).toBe(OCTOCAT_TRANSPARENT);
    expect(codeOf({ kind: 'code', value: OCTOCAT_TRANSPARENT }, 'color')).toBe(OCTOCAT_TRANSPARENT);
  });

  it('makes no code from a broken seed code', () => {
    expect(() => readSeed({ kind: 'code', value: 'px.!!!' })).toThrow();
    expect(codeOf({ kind: 'code', value: 'px.!!!' }, 'color')).toBeNull();
  });
});

describe('lookOf', () => {
  it('is the seed code of the character on the stage, whatever its id and name', () => {
    const onStage = { ...profileFromText('octocat'), id: 'char-3', name: 'Octo' };
    const look = lookOf(onStage, 'color');
    expect(look?.seed).toBe(OCTOCAT);
    expect(look?.background).toBe('#a896e8');
    expect(look?.transparent).toBe(false);
    expect(lookOf(onStage, 'transparent')?.seed).toBe(OCTOCAT_TRANSPARENT);
  });

  it('is null without a character, or for one Pixel Agents would not read', () => {
    expect(lookOf(null, 'color')).toBeNull();
    expect(lookOf({ body: 42 }, 'color')).toBeNull();
  });
});

describe('latest', () => {
  it('works on the last value of a run only, after the delay', () => {
    vi.useFakeTimers();
    const done: string[] = [];
    const run = latest((value: string) => value.toUpperCase(), (result) => done.push(result), 150);
    run.schedule('o');
    run.schedule('oc');
    vi.advanceTimersByTime(149);
    expect(done).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(done).toEqual(['OC']);
  });

  it('flushes at once, and drops what was waiting when cancelled', () => {
    vi.useFakeTimers();
    const done: string[] = [];
    const run = latest((value: string) => value, (result) => done.push(result), 150);
    run.schedule('waiting');
    run.flush('now');
    expect(done).toEqual(['now']);
    run.schedule('dropped');
    run.cancel();
    vi.advanceTimersByTime(500);
    expect(done).toEqual(['now']);
  });
});
