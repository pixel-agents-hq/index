/**
 * Everything pixatar takes from the pinned Pixel Agents checkout, imported in this one
 * place. These are upstream's own sources, bundled into the package at build time: the
 * profile format and its validation, the wardrobe, the renderer and the randomizer are
 * Pixel Agents', so a vendor bump brings new parts and themes along unchanged.
 */

export { sheetToDirectionSprites } from '../../../vendor/pixel-agents/core/src/assets/characterSheet.js';
export {
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHAR_FRAMES_PER_ROW,
  CHARACTER_DIRECTIONS,
} from '../../../vendor/pixel-agents/core/src/assets/constants.js';
export { SHEET_FRAMES } from '../../../vendor/pixel-agents/core/src/assets/seatedFrame.js';
export type { CharacterDirectionSprites } from '../../../vendor/pixel-agents/core/src/assets/types.js';
export {
  CHARACTER_PROFILE_VERSION,
  CHARACTER_SLOTS,
  type CharacterColor,
  type CharacterPixelEdits,
  type CharacterProfile,
  type CharacterSlot,
  EYE_ROWS,
  parseCharacterProfiles,
} from '../../../vendor/pixel-agents/core/src/characterProfiles.js';
export {
  newProfile,
  parseConfigFile,
  randomize,
} from '../../../vendor/pixel-agents/webview-ui/src/characters/profiles.js';
export { CharacterRenderer } from '../../../vendor/pixel-agents/webview-ui/src/characters/renderer.js';
export {
  EYE_FOLDERS,
  EYE_SHAPES,
  LAYERS,
  UNDERWEAR,
} from '../../../vendor/pixel-agents/webview-ui/src/characters/slots.js';
export {
  decodeWardrobe,
  parseWardrobeManifest,
  type Rgba,
  type Wardrobe,
} from '../../../vendor/pixel-agents/webview-ui/src/characters/wardrobe.js';
export {
  MUGSHOT_CROP_SIDE_PX,
  MUGSHOT_CROP_TOP_ROW,
  TYPE_FRAME_DURATION_SEC,
  WALK_FRAME_DURATION_SEC,
} from '../../../vendor/pixel-agents/webview-ui/src/constants.js';
export { rng } from '../../../vendor/pixel-agents/webview-ui/src/music/rng.js';
