import { PixatarError } from './errors.js';
import {
  CHARACTER_PROFILE_VERSION,
  type CharacterColor,
  type CharacterProfile,
  parseCharacterProfiles,
} from './vendor.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A copy of `value` with every object's keys sorted, so equal profiles serialise alike. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

function canonicalColor(cv: CharacterColor): CharacterColor {
  const out: CharacterColor = { h: cv.h, s: cv.s, b: cv.b, c: cv.c };
  if (cv.colorize) out.colorize = true;
  if (cv.palette !== undefined) out.palette = cv.palette;
  return out;
}

/**
 * A profile as pixatar keeps it: validated and migrated exactly as Pixel Agents reads one
 * (upstream's parseCharacterProfiles), without the fields that name a copy rather than
 * describe a look (`id`, `name`), with nothing set to undefined, `colorize` only when on,
 * no empty `colors` or `edits`, and every key sorted. Two profiles that draw alike through
 * the same fields come out equal, so they get the same seed.
 */
export function canonicalProfile(input: unknown): CharacterProfile {
  const parsed = isRecord(input) ? parseCharacterProfiles([input])?.[0] : undefined;
  if (!parsed) {
    throw new PixatarError('invalid-profile', 'Pixel Agents would not read this as a character profile.');
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === undefined || key === 'id' || key === 'name') continue;
    if (key === 'colors') {
      const colors = Object.entries(value as Record<string, CharacterColor>);
      if (colors.length) out.colors = Object.fromEntries(colors.map(([k, cv]) => [k, canonicalColor(cv)]));
    } else if (key === 'edits') {
      if (Object.keys(value as object).length) out.edits = structuredClone(value);
    } else {
      out[key] = isRecord(value) || Array.isArray(value) ? structuredClone(value) : value;
    }
  }
  out.v ??= CHARACTER_PROFILE_VERSION;
  return sortKeys(out) as CharacterProfile;
}

export const sameProfile = (a: CharacterProfile, b: CharacterProfile): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
