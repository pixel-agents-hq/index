import { describe, expect, it } from 'vitest';

import { MOOD_KEYS, parseSongCode } from './songCode.js';

/**
 * The pinned upstream's own song-code module, loaded at test time only (a
 * variable specifier, so this package's typecheck never compiles vendor
 * sources under its stricter flags).
 */
const UPSTREAM_SONG_CODE = new URL('../../../../vendor/pixel-agents/webview-ui/src/music/songCode.ts', import.meta.url).href;
const UPSTREAM_MOODS = new URL('../../../../vendor/pixel-agents/webview-ui/src/music/moods.ts', import.meta.url).href;

interface UpstreamSongCode {
  parseSongCode: (code: string) => { moodKey: string; root: number; seed: number } | null;
  ROOT_MIN: number;
  ROOT_MAX: number;
}

describe('parseSongCode', () => {
  it('canonicalises a code the way the radio prints it', () => {
    expect(parseSongCode('town-5-8f3a21c0')).toEqual({ code: 'TOWN-5-8F3A21C0', mood: 'town' });
    expect(parseSongCode('  NIGHT-0-1a  ')).toEqual({ code: 'NIGHT-0-0000001A', mood: 'night' });
    // The radio's font draws 0 like an o; a typed o reads as 0.
    expect(parseSongCode('lab-o-fooo')).toEqual({ code: 'LAB-0-0000F000', mood: 'lab' });
  });

  it('refuses what the radio refuses', () => {
    for (const bad of ['', 'TOWN', 'TOWN-5', 'JAZZ-1-00000000', 'TOWN-9-00000000', 'TOWN-5-123456789', 'TOWN-5-XYZ']) {
      expect(parseSongCode(bad)).toBeNull();
    }
  });

  it('agrees with the pinned upstream’s own parser and mood list', async () => {
    const upstream = (await import(UPSTREAM_SONG_CODE)) as UpstreamSongCode;
    const { MOOD_KEYS: upstreamMoods } = (await import(UPSTREAM_MOODS)) as { MOOD_KEYS: readonly string[] };
    expect([...MOOD_KEYS]).toEqual([...upstreamMoods]);

    const samples = [
      ...upstreamMoods.flatMap((mood) =>
        Array.from({ length: upstream.ROOT_MAX - upstream.ROOT_MIN + 2 }, (_, step) => `${mood}-${step}-8F3A21C0`),
      ),
      'town-5-o', 'TOWN-5-FFFFFFFF', 'town-5-0', 'jazz-1-0', 'TOWN-5-', 'TOWN--1', ' rain-3-abc ', 'RAIN-3-ABCDEFGH',
    ];
    for (const sample of samples) {
      const ours = parseSongCode(sample);
      const theirs = upstream.parseSongCode(sample);
      expect(ours === null, sample).toBe(theirs === null);
      if (ours && theirs) {
        expect(ours.mood).toBe(theirs.moodKey);
        // Our canonical code reads back to the same tune.
        expect(upstream.parseSongCode(ours.code)).toEqual(theirs);
      }
    }
  });
});
