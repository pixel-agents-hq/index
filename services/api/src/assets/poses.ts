/**
 * Builds the "poses" a browser can animate an asset through — one entry per
 * visually distinct static variant (a furniture orientation/state, a
 * character or pet facing), each carrying its frames in playback order as
 * embedded PNG data URLs.
 *
 * Furniture frames come from a manifest's `animationGroup` (upstream's own
 * grouping — see `manifest.ts`'s `flattenManifest`); an entry with none is
 * its own single-frame pose. Character and pet frames have no manifest
 * grouping to read (#105 — a character/pet manifest carries only an id), so
 * their poses are the fixed per-direction walk-cycle slice
 * (`decodeCharacter.ts`/`decodePet.ts`'s own frame order) instead.
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
 */
function facingPoses(down: string[][][], up: string[][][], right: string[][][]): AssetPose[] {
  const take = (rows: string[][][]) => rows.slice(0, WALK_FRAME_COUNT).map(dataUrl);
  const poses: AssetPose[] = [];

  const downFrames = take(down);
  if (downFrames.length > 0) poses.push({ key: 'down', label: 'Down', frames: downFrames });

  const upFrames = take(up);
  if (upFrames.length > 0) poses.push({ key: 'up', label: 'Up', frames: upFrames });

  const rightFrames = take(right);
  if (rightFrames.length > 0) {
    poses.push({ key: 'right', label: 'Right', frames: rightFrames });
    poses.push({ key: 'left', label: 'Left', mirror: true, frames: rightFrames });
  }

  return poses;
}

function characterPoses(id: string, sprites: Record<string, CharacterFrames>): AssetPose[] {
  const frames = sprites[id];
  return frames ? facingPoses(frames.down, frames.up, frames.right) : [];
}

function petPoses(id: string, sprites: Record<string, PetFrames>): AssetPose[] {
  const frames = sprites[id];
  return frames ? facingPoses(frames.walkDown, frames.walkUp, frames.walkRight) : [];
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
