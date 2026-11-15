/**
 * pixatar: deterministic Pixel Agents characters. A seed (any text, or a seed code) makes a
 * character profile; the profile is drawn by Pixel Agents' own renderer as a sprite sheet
 * (always transparent) and as an avatar on a background colour derived from the seed, or on
 * nothing when the seed code says so.
 */

import { backgroundColor } from './background.js';
import { canonicalProfile } from './canonical.js';
import type { RgbaImage } from './image.js';
import { encodePng } from './png.js';
import {
  type AvatarOptions,
  type FrameOptions,
  renderAvatar,
  renderFrame,
  renderSheet,
  renderSprites,
  type SheetOptions,
} from './render.js';
import { type AvatarBackground, decodeSeed, seedFromProfile, type SeedOptions } from './seed.js';
import type { CharacterDirectionSprites, CharacterProfile } from './vendor.js';

export { backgroundColor } from './background.js';
export { canonicalProfile } from './canonical.js';
export { PixatarError, type PixatarErrorCode } from './errors.js';
export { VENDOR } from './generated/wardrobe.js';
export type { RgbaImage } from './image.js';
export { encodePng } from './png.js';
export {
  AVATAR_SIZE,
  type AvatarOptions,
  type Direction,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  type FrameOptions,
  renderAvatar,
  renderFrame,
  renderSheet,
  renderSprites,
  SHEET_HEIGHT,
  SHEET_WIDTH,
  type SheetOptions,
} from './render.js';
export {
  type AvatarBackground,
  decodeSeed,
  decodeSeedCode,
  isSeedCode,
  normalizeSeed,
  profileFromCode,
  profileFromSeed,
  profileFromText,
  randomSeed,
  SEED_PREFIX,
  type SeedContents,
  seedFromProfile,
  seedFromText,
  type SeedOptions,
} from './seed.js';
export {
  CHARACTER_PROFILE_VERSION,
  type CharacterColor,
  type CharacterDirectionSprites,
  type CharacterProfile,
  SHEET_FRAMES,
  TYPE_FRAME_DURATION_SEC,
  WALK_FRAME_DURATION_SEC,
} from './vendor.js';
/** The decoded wardrobe pixatar draws with (upstream's Wardrobe): for tools that drive upstream's own editor. */
export { getWardrobe } from './wardrobe.js';

/** A character, everything about it derived from its seed. */
export interface Pixatar {
  /** Its seed code: give it back to pixatar() for this exact character and avatar. */
  seed: string;
  /** Its Pixel Agents character profile (what the Characters view's "Load config" reads). */
  profile: CharacterProfile;
  /** Its background colour, #rrggbb (also when the avatar is transparent). */
  background: string;
  /** What its avatar is drawn on, as its seed code says. The sprite sheet is always transparent. */
  avatarBackground: AvatarBackground;
  sheet: (options?: SheetOptions) => RgbaImage;
  frame: (options?: FrameOptions) => RgbaImage;
  avatar: (options?: AvatarOptions) => RgbaImage;
  sheetPng: (options?: SheetOptions) => Uint8Array;
  avatarPng: (options?: AvatarOptions) => Uint8Array;
  sprites: () => CharacterDirectionSprites;
}

/**
 * The character a seed (any text, or a seed code) or a profile stands for. `options.background`
 * overrides what the seed says about the avatar's background (a profile alone says 'color').
 */
export function pixatar(seedOrProfile: string | CharacterProfile, options: SeedOptions = {}): Pixatar {
  const decoded =
    typeof seedOrProfile === 'string'
      ? decodeSeed(seedOrProfile)
      : { profile: canonicalProfile(seedOrProfile), background: 'color' as const };
  const { profile } = decoded;
  const avatarBackground = options.background ?? decoded.background;
  const seed = seedFromProfile(profile, { background: avatarBackground });
  const background = backgroundColor(profile);
  const avatarOptions = (options: AvatarOptions = {}): AvatarOptions => ({
    background: avatarBackground === 'transparent' ? null : background,
    ...options,
  });
  return {
    seed,
    profile,
    background,
    avatarBackground,
    sheet: (options) => renderSheet(profile, options),
    frame: (options) => renderFrame(profile, options),
    avatar: (options) => renderAvatar(profile, avatarOptions(options)),
    sheetPng: (options) => encodePng(renderSheet(profile, options)),
    avatarPng: (options) => encodePng(renderAvatar(profile, avatarOptions(options))),
    sprites: () => renderSprites(profile),
  };
}
