/**
 * Song codes: a Pixel Agents office radio tune as mood, root and seed
 * (`TOWN-5-8F3A21C0`). A hand-kept LOCAL copy of the pinned upstream's
 * `webview-ui/src/music/songCode.ts` `parseSongCode` and `moods.ts`
 * `MOOD_KEYS`, not an import of them — the same "read the pinned upstream's
 * shape at the boundary, never cross it with a module import" rule
 * `assets/manifest.ts`'s header documents. `songCode.test.ts` checks this
 * copy against upstream's own parser, so a vendor bump that changes the
 * format fails there instead of drifting.
 */

/** The radio's moods, in upstream's order. */
export const MOOD_KEYS = ['town', 'route', 'lab', 'night', 'orbit', 'rain', 'dawn', 'arcade'] as const;
export type MoodKey = (typeof MOOD_KEYS)[number];

/** Tune roots run D3..A#3: the code's middle part is the root above the lowest. */
const ROOT_STEPS = 58 - 50;

export interface SongCode {
  /** Upper case with the seed as 8 hex digits — what's stored, and what the radio prints itself. */
  code: string;
  mood: MoodKey;
}

/** A code as the radio reads it, canonicalised; null when the radio wouldn't play it. */
export function parseSongCode(input: string): SongCode | null {
  // The radio's font draws 0 like an o, so the radio reads a typed o as 0; so does this.
  const m = /^\s*([a-z]+)-([\do])-([0-9a-fo]{1,8})\s*$/i.exec(input);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const mood = m[1].toLowerCase() as MoodKey;
  const step = Number(m[2].replace(/o/i, '0'));
  if (!MOOD_KEYS.includes(mood) || step > ROOT_STEPS) return null;
  const seed = parseInt(m[3].replace(/o/gi, '0'), 16) >>> 0;
  return { code: `${mood.toUpperCase()}-${step}-${seed.toString(16).toUpperCase().padStart(8, '0')}`, mood };
}
