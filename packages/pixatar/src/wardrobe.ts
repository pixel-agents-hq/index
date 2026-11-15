/** The baked wardrobe (scripts/generate-wardrobe.mjs), decoded once into upstream's renderer. */

import { unzlibSync } from 'fflate';

import { fromBase64 } from './bytes.js';
import { ART, MANIFEST, PIXELS } from './generated/wardrobe.js';
import {
  CharacterRenderer,
  decodeWardrobe,
  EYE_FOLDERS,
  parseWardrobeManifest,
  type Rgba,
  type Wardrobe,
} from './vendor.js';

let renderer: CharacterRenderer | null = null;

/** Upstream's character renderer over the whole wardrobe, built on first use. */
export function getRenderer(): CharacterRenderer {
  if (renderer) return renderer;
  const pixels = unzlibSync(fromBase64(PIXELS));
  const files = new Map<string, Rgba>();
  let at = 0;
  for (const [path, width, height] of ART) {
    const size = width * height * 4;
    files.set(path, { width, height, data: new Uint8ClampedArray(pixels.buffer, pixels.byteOffset + at, size) });
    at += size;
  }
  renderer = new CharacterRenderer(decodeWardrobe(parseWardrobeManifest(MANIFEST), files, EYE_FOLDERS));
  return renderer;
}

export const getWardrobe = (): Wardrobe => getRenderer().wardrobe;
