/**
 * Builds the "poses" a browser can animate an asset through — one entry per
 * visually distinct static variant (a furniture orientation/state, a
 * character or pet facing or action), each carrying its frames in playback
 * order as embedded PNG data URLs.
 *
 * Furniture frames come from a manifest's `animationGroup` (upstream's own
 * grouping — see `manifest.ts`'s `flattenManifest`); an entry with none is
 * its own single-frame pose. Character and pet frames have no manifest
 * grouping to read (#105 — a character/pet manifest carries only an id), so
 * their poses are read straight out of the fixed frame layout
 * `decodeCharacter.ts`/`decodePet.ts` already decoded and stored — the walk
 * cycle for both, plus a character's typing/reading frames and a pet's idle
 * frames (see `characterPoses`/`petPoses` below). Those two kinds decode the
 * exact same raw PNGs vendor's own live-office renderer does, so every one of
 * these slices is checked against vendor's own frame-index mapping, not
 * re-derived from scratch.
 *
 * Kept independent of Fastify so it's directly unit-testable against
 * hand-built manifest/sprite fixtures, the same reasoning `manifest.ts`
 * follows for `flattenManifest`.
 */

import type * as schema from '../db/schema.js';
import type { CharacterFrames } from './decodeCharacter.js';
import type { PetFrames } from './decodePet.js';
import type { FlattenedAsset } from './manifest.js';
import { encodeSpritePng } from './spritePng.js';

export interface AssetPose {
  key: string;
  label: string;
  /** The client should mirror this pose horizontally — a "left" pose reusing "right"'s own frames, same convention upstream's character renderer uses. */
  mirror?: boolean;
  /** Base64 PNG data URLs, in playback order. Always at least one. */
  frames: string[];
}

function dataUrl(grid: string[][]): string {
  return `data:image/png;base64,${encodeSpritePng(grid).toString('base64')}`;
}

function titleCase(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/**
 * Entries sharing an `animationGroup` are frames of ONE pose, ordered by
 * `frame`; every other entry is its own single-frame pose. A `Map` preserves
 * first-seen order, which is `flattenManifest`'s own root-to-leaf order, so
 * poses come out in the manifest's natural order without a separate sort.
 */
function furniturePoses(manifest: FlattenedAsset[], sprites: Record<string, string[][]>): AssetPose[] {
  const groups = new Map<string, FlattenedAsset[]>();
  for (const entry of manifest) {
    const key = entry.animationGroup ?? entry.id;
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }

  const poses: AssetPose[] = [];
  for (const [key, entries] of groups) {
    const ordered = [...entries].sort((a, b) => (a.frame ?? 0) - (b.frame ?? 0));
    const first = ordered[0];
    if (!first) continue;
    const frames: string[] = [];
    for (const entry of ordered) {
      const grid = sprites[entry.id];
      if (grid) frames.push(dataUrl(grid));
    }
    if (frames.length === 0) continue;
    const parts = [first.orientation, first.state].filter((p): p is string => Boolean(p)).map(titleCase);
    poses.push({ key, label: parts.length > 0 ? parts.join(' · ') : first.name, frames });
  }
  return poses;
}

/** How many leading frames of a 7-frame character row (or a 3-frame pet row) count as its walk cycle. */
const WALK_FRAME_COUNT = 3;

/**
 * Shared by characters and pets: both decode to a down/up/right frame-array
 * triple (`walkDown`/`walkUp`/`walkRight` for a pet, `down`/`up`/`right` for
 * a character), and both mirror `right` into `left` at render time rather
 * than storing a fourth direction — the same choice upstream's own character
 * renderer makes.
 *
 * `select` picks which frames of a direction's raw array make up this
 * animation — defaults to the leading walk-cycle slice everyone gets, but
 * `characterPoses` also calls this with a different slice for the typing and
 * reading animations (same down/up/right/left shape, different frames).
 * `keyPrefix`/`labelPrefix` namespace a second call against the same
 * direction set so its pose keys/labels don't collide with the walk pass.
 */
function facingPoses(
  down: string[][][],
  up: string[][][],
  right: string[][][],
  opts: {
    keyPrefix?: string;
    labelPrefix?: string;
    select?: (rows: string[][][]) => string[][][];
  } = {},
): AssetPose[] {
  const { keyPrefix, labelPrefix, select = (rows) => rows.slice(0, WALK_FRAME_COUNT) } = opts;
  const take = (rows: string[][][]) => select(rows).map(dataUrl);
  const key = (base: string) => (keyPrefix ? `${keyPrefix}-${base}` : base);
  const label = (base: string) => (labelPrefix ? `${labelPrefix} · ${base}` : base);
  const poses: AssetPose[] = [];

  const downFrames = take(down);
  if (downFrames.length > 0) poses.push({ key: key('down'), label: label('Down'), frames: downFrames });

  const upFrames = take(up);
  if (upFrames.length > 0) poses.push({ key: key('up'), label: label('Up'), frames: upFrames });

  const rightFrames = take(right);
  if (rightFrames.length > 0) {
    poses.push({ key: key('right'), label: label('Right'), frames: rightFrames });
    poses.push({ key: key('left'), label: label('Left'), mirror: true, frames: rightFrames });
  }

  return poses;
}

/**
 * Raw frame indices for a character's typing and reading animations — the
 * same two pairs vendor's own `getCharacterSprites()`
 * (`webview-ui/src/office/sprites/spriteData.ts`) slices from the identical
 * 7-frame-per-direction row `facingPoses`'s walk slice reads frames [0-2]
 * from (frame order: walk1, walk2, walk3, type1, type2, read1, read2).
 * Copied verbatim rather than re-derived so this can never silently diverge
 * from what the real product renders for the same sprite sheet.
 */
const CHARACTER_TYPING_FRAMES = [3, 4] as const;
const CHARACTER_READING_FRAMES = [5, 6] as const;

function pickFrames(indices: readonly number[]): (rows: string[][][]) => string[][][] {
  return (rows) => indices.map((i) => rows[i]).filter((frame): frame is string[][] => Boolean(frame));
}

/**
 * A character's poses: the walk cycle every kind gets, plus the two
 * additional real animations vendor's own renderer drives from this exact
 * sprite sheet (typing = seated-at-desk, reading = the tool-reading variant,
 * `isReadingTool()` in `characters.ts` picks between them) — both previously
 * decoded and stored (`decodeCharacter.ts` extracts all 7 frames per
 * direction) but never surfaced as poses until now.
 */
function characterPoses(id: string, sprites: Record<string, CharacterFrames>): AssetPose[] {
  const frames = sprites[id];
  if (!frames) return [];
  return [
    ...facingPoses(frames.down, frames.up, frames.right),
    ...facingPoses(frames.down, frames.up, frames.right, {
      keyPrefix: 'typing',
      labelPrefix: 'Typing',
      select: pickFrames(CHARACTER_TYPING_FRAMES),
    }),
    ...facingPoses(frames.down, frames.up, frames.right, {
      keyPrefix: 'reading',
      labelPrefix: 'Reading',
      select: pickFrames(CHARACTER_READING_FRAMES),
    }),
  ];
}

/**
 * A pet's idle animation — unlike a character's typing/reading, this is not
 * a different slice of the walk row: `decodePet.ts` stores it as fully
 * separate `idleDown`/`idleUp` frame arrays (see its file header). Down/up
 * only: vendor's own `petSpriteData.ts` has no side-on idle art either — it
 * reuses the down sprite as a stand-in "idle right" and the up sprite as
 * "idle left" purely as a live-office rendering fallback. Relabeling that
 * reused art as a right/left pose here would show a viewer a direction that
 * was never actually drawn, so this only ever emits the real down/up frames.
 */
function petIdlePoses(idleDown: string[][][], idleUp: string[][][]): AssetPose[] {
  const poses: AssetPose[] = [];

  const downFrames = idleDown.map(dataUrl);
  if (downFrames.length > 0) poses.push({ key: 'idle-down', label: 'Idle · Down', frames: downFrames });

  const upFrames = idleUp.map(dataUrl);
  if (upFrames.length > 0) poses.push({ key: 'idle-up', label: 'Idle · Up', frames: upFrames });

  return poses;
}

function petPoses(id: string, sprites: Record<string, PetFrames>): AssetPose[] {
  const frames = sprites[id];
  if (!frames) return [];
  return [
    ...facingPoses(frames.walkDown, frames.walkUp, frames.walkRight),
    ...petIdlePoses(frames.idleDown, frames.idleUp),
  ];
}

/** `manifest`/`sprites` are `jsonb` columns — this is the one place their per-kind shape (#105) is read back out. */
export function buildAssetPoses(asset: Pick<schema.CustomAsset, 'assetKind' | 'manifest' | 'sprites'>): AssetPose[] {
  const manifest = asset.manifest as unknown[];
  const sprites = asset.sprites as Record<string, unknown>;
  switch (asset.assetKind) {
    case 'furniture':
      return furniturePoses(manifest as FlattenedAsset[], sprites as Record<string, string[][]>);
    case 'character': {
      const id = (manifest[0] as { id: string } | undefined)?.id;
      return id ? characterPoses(id, sprites as Record<string, CharacterFrames>) : [];
    }
    case 'pet': {
      const id = (manifest[0] as { id: string } | undefined)?.id;
      return id ? petPoses(id, sprites as Record<string, PetFrames>) : [];
    }
  }
}
