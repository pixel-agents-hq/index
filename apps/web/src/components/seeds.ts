/**
 * The character designer's seeds (`SeedPanel.tsx`): a seed makes a character,
 * the same one every time, drawn by `@pixel-index/pixatar`. There are two
 * kinds, and they promise different things:
 *
 * - **Free text** — any string (a name, an email address, a user id) — is
 *   hashed into a character. The same text deals the same character for as
 *   long as the pinned Pixel Agents' wardrobe stays as it is; a vendor bump
 *   that adds parts can deal it differently.
 * - **A seed code** (`px.` + base64url) *is* the character, written down: its
 *   exact parts and colours, and whether its avatar is transparent. It keeps
 *   its character across versions, for as long as Pixel Agents keeps the parts
 *   it names.
 *
 * Every look has a seed code; a text's code is what to keep to hold on to its
 * character for good.
 */

import {
  type AvatarBackground,
  backgroundColor,
  type CharacterProfile,
  decodeSeed,
  isSeedCode,
  profileFromText,
  seedFromProfile,
} from '@pixel-index/pixatar';

export type SeedKind = 'text' | 'code';

export interface TypedSeed {
  kind: SeedKind;
  value: string;
}

/**
 * The page address's seed, if any: `?seed=px.…` is a seed code and `?text=…`
 * free text. Query parameters rather than pixatar's own `#px.` / `#t.`
 * fragments, because the index's sign-in already arrives in the fragment
 * (`#pixelIndexLoginCode=`, see `auth/AuthProvider.tsx`), and beside the
 * designer's existing `?from=`.
 */
export function seedFromSearch(params: URLSearchParams): TypedSeed | null {
  const code = params.get('seed');
  if (code !== null && isSeedCode(code)) return { kind: 'code', value: code };
  const text = params.get('text');
  if (text !== null) return { kind: 'text', value: text };
  return null;
}

/** The page address's query for a seed (replacing any `?from=`: the seed now says the character). */
export function searchOf({ kind, value }: TypedSeed): URLSearchParams {
  return new URLSearchParams(kind === 'code' ? { seed: value } : { text: value });
}

/**
 * What a typed seed says: the character, and what its avatar sits on — `null`
 * for text, which says nothing about it. Throws a PixatarError for a code that
 * isn't one.
 */
export function readSeed({ kind, value }: TypedSeed): {
  profile: CharacterProfile;
  background: AvatarBackground | null;
} {
  return kind === 'code' ? decodeSeed(value) : { profile: profileFromText(value), background: null };
}

/** The seed code `typed` makes with the toggle at `background`, or null when it makes none. */
export function codeOf(typed: TypedSeed, background: AvatarBackground): string | null {
  try {
    const read = readSeed(typed);
    return seedFromProfile(read.profile, { background: read.background ?? background });
  } catch {
    return null;
  }
}

/** A character as the seed panel shows it. */
export interface Look {
  /** Its seed code: give it back for this exact character and avatar. */
  seed: string;
  /** Its canonical profile, as the seed code decodes. */
  profile: CharacterProfile;
  /** The colour its avatar sits on (also when the avatar is transparent). */
  background: string;
  transparent: boolean;
}

/**
 * The look of the character on the designer's stage, or null when it has none
 * a seed can say (no character, or one wearing a part this wardrobe lacks).
 */
export function lookOf(profile: Record<string, unknown> | null, avatarBackground: AvatarBackground): Look | null {
  if (!profile) return null;
  try {
    const seed = seedFromProfile(profile, { background: avatarBackground });
    return {
      seed,
      profile: decodeSeed(seed).profile,
      background: backgroundColor(seed),
      transparent: avatarBackground === 'transparent',
    };
  } catch {
    return null;
  }
}

/**
 * Work on the latest of a run of values only: a value waits `delay` ms for the
 * next one, and a result whose value has been overtaken (by a newer value,
 * `flush` or `cancel`) is dropped, so a slow result never lands over a newer one.
 */
export interface Latest<T> {
  /** Work on `value` once `delay` ms pass without another. */
  schedule: (value: T) => void;
  /** Work on `value` now, overtaking anything waiting. */
  flush: (value: T) => void;
  /** Drop anything waiting. */
  cancel: () => void;
}

export function latest<T, R>(work: (value: T) => R, commit: (result: R) => void, delay: number): Latest<T> {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    generation++;
    clearTimeout(timer);
    timer = undefined;
  };

  const run = (value: T, mine: number) => {
    const result = work(value);
    if (mine === generation) commit(result);
  };

  return {
    schedule(value) {
      cancel();
      const mine = generation;
      timer = setTimeout(() => run(value, mine), delay);
    },
    flush(value) {
      cancel();
      run(value, generation);
    },
    cancel,
  };
}
