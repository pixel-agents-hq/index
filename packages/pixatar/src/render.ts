/**
 * What pixatar draws from a profile, all with upstream's own renderer: the 128x96 character
 * sheet, a single frame, and the avatar (Pixel Agents' mug shot: the head square of the
 * front-facing sprite, on the character's background colour).
 */

import { backgroundColor } from './background.js';
import { canonicalProfile } from './canonical.js';
import { blankImage, blit, fill, type RgbaImage } from './image.js';
import {
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHAR_FRAMES_PER_ROW,
  CHARACTER_DIRECTIONS,
  type CharacterDirectionSprites,
  type CharacterProfile,
  MUGSHOT_CROP_SIDE_PX,
  MUGSHOT_CROP_TOP_ROW,
  sheetToDirectionSprites,
} from './vendor.js';
import { getRenderer } from './wardrobe.js';

export const SHEET_WIDTH = CHAR_FRAME_W * CHAR_FRAMES_PER_ROW;
export const SHEET_HEIGHT = CHAR_FRAME_H * CHARACTER_DIRECTIONS.length;
export const FRAME_WIDTH = CHAR_FRAME_W;
export const FRAME_HEIGHT = CHAR_FRAME_H;
export const AVATAR_SIZE = MUGSHOT_CROP_SIDE_PX;
/**
 * The avatar's first sprite column: the 16-wide frame centred in the 20-wide square, 2 empty
 * columns each side. Upstream's MUGSHOT_CROP_LEFT_COL (-1) leaves 1 on the left and 3 on the
 * right, so its mug shot sits a pixel left of centre.
 */
const AVATAR_CROP_LEFT = -(AVATAR_SIZE - FRAME_WIDTH) / 2;

/** The sheet's rows, plus left: the right row mirrored, as the office draws it. */
export type Direction = 'down' | 'up' | 'right' | 'left';

interface Scaled {
  /** Output pixels per sprite pixel, a whole number (default 1). */
  scale?: number;
  /** A #rrggbb colour to draw on; null (the default, except for avatars) leaves it transparent. */
  background?: string | null;
}

export type SheetOptions = Scaled;

export interface FrameOptions extends Scaled {
  direction?: Direction;
  /** The frame in its row: 0-2 walk, 3-4 type, 5-6 read, 7 seated (see SHEET_FRAMES). */
  frame?: number;
}

export interface AvatarOptions extends Scaled {
  /** Defaults to the character's backgroundColor; null for a transparent avatar. */
  background?: string | null;
}

function scaleOf(options: Scaled): number {
  const scale = options.scale ?? 1;
  if (!Number.isInteger(scale) || scale < 1 || scale > 64) {
    throw new RangeError('scale must be a whole number from 1 to 64');
  }
  return scale;
}

function canvas(width: number, height: number, background: string | null | undefined): RgbaImage {
  const image = blankImage(width, height);
  if (background) fill(image, background);
  return image;
}

/** The profile's sheet as upstream composes it. The renderer caches it: read it, never write it. */
function sheetOf(profile: CharacterProfile): RgbaImage {
  const data = getRenderer().sheet(canonicalProfile(profile));
  return { width: SHEET_WIDTH, height: SHEET_HEIGHT, data };
}

/** One frame on its own, so a crop reaching past its edges finds nothing (not the next frame). */
function frameOf(profile: CharacterProfile, row: number, frame: number): RgbaImage {
  const one = blankImage(FRAME_WIDTH, FRAME_HEIGHT);
  blit(sheetOf(profile), frame * FRAME_WIDTH, row * FRAME_HEIGHT, FRAME_WIDTH, FRAME_HEIGHT, one);
  return one;
}

/** The whole 128x96 character sheet: rows down, up, right; 8 frames each (walk1-3, type1-2, read1-2, seated). */
export function renderSheet(profile: CharacterProfile, options: SheetOptions = {}): RgbaImage {
  const scale = scaleOf(options);
  const out = canvas(SHEET_WIDTH * scale, SHEET_HEIGHT * scale, options.background);
  blit(sheetOf(profile), 0, 0, SHEET_WIDTH, SHEET_HEIGHT, out, 0, 0, scale);
  return out;
}

/** One 16x32 frame. */
export function renderFrame(profile: CharacterProfile, options: FrameOptions = {}): RgbaImage {
  const scale = scaleOf(options);
  const direction = options.direction ?? 'down';
  const frame = options.frame ?? 0;
  if (!Number.isInteger(frame) || frame < 0 || frame >= CHAR_FRAMES_PER_ROW) {
    throw new RangeError(`frame must be a whole number from 0 to ${CHAR_FRAMES_PER_ROW - 1}`);
  }
  const row = CHARACTER_DIRECTIONS.indexOf(direction === 'left' ? 'right' : direction);
  if (row < 0) throw new RangeError(`unknown direction ${direction}`);
  const one = frameOf(profile, row, frame);
  if (direction === 'left') mirror(one);
  const out = canvas(FRAME_WIDTH * scale, FRAME_HEIGHT * scale, options.background);
  blit(one, 0, 0, FRAME_WIDTH, FRAME_HEIGHT, out, 0, 0, scale);
  return out;
}

function mirror(image: RgbaImage): void {
  const { width, height, data } = image;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width / 2; x++) {
      const a = (y * width + x) * 4;
      const b = (y * width + width - 1 - x) * 4;
      for (let c = 0; c < 4; c++) [data[a + c], data[b + c]] = [data[b + c], data[a + c]];
    }
  }
}

/**
 * The avatar: Pixel Agents' mug shot (CharacterMugShot: a 20x20 square over the head of the
 * first front-facing frame), centred across the frame, on the character's background colour.
 */
export function renderAvatar(profile: CharacterProfile, options: AvatarOptions = {}): RgbaImage {
  const scale = scaleOf(options);
  const background = options.background === undefined ? backgroundColor(profile) : options.background;
  const out = canvas(AVATAR_SIZE * scale, AVATAR_SIZE * scale, background);
  blit(frameOf(profile, 0, 0), AVATAR_CROP_LEFT, MUGSHOT_CROP_TOP_ROW, AVATAR_SIZE, AVATAR_SIZE, out, 0, 0, scale);
  return out;
}

/** The sheet as Pixel Agents' office takes a character: per direction, frames of '#rrggbb' / '' pixels. */
export const renderSprites = (profile: CharacterProfile): CharacterDirectionSprites =>
  sheetToDirectionSprites(sheetOf(profile).data, SHEET_WIDTH);
