import { describe, expect, it } from 'vitest';

import type { CharacterFrames } from './decodeCharacter.js';
import type { PetFrames } from './decodePet.js';
import type { FlattenedAsset } from './manifest.js';
import { buildAssetPoses } from './poses.js';

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';

function grid(fill: string, width = 2, height = 2): string[][] {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => fill));
}

function furnitureAsset(manifest: FlattenedAsset[], sprites: Record<string, string[][]>) {
  return { assetKind: 'furniture' as const, manifest, sprites };
}

describe('buildAssetPoses — furniture', () => {
  it('gives a flat single-variant item one pose, labeled from its name', () => {
    const manifest: FlattenedAsset[] = [
      {
        id: 'BOOKSHELF',
        name: 'Bookshelf',
        label: 'Bookshelf',
        category: 'wall',
        file: 'BOOKSHELF.png',
        width: 32,
        height: 16,
        footprintW: 2,
        footprintH: 1,
        isDesk: false,
        canPlaceOnWalls: true,
        groupId: 'BOOKSHELF',
      },
    ];
    const poses = buildAssetPoses(furnitureAsset(manifest, { BOOKSHELF: grid('#111111') }));

    expect(poses).toHaveLength(1);
    expect(poses[0]).toMatchObject({ label: 'Bookshelf', frames: [expect.stringContaining(PNG_DATA_URL_PREFIX)] });
  });

  it("collapses PC-shaped rotation/state/animation nesting into 4 poses — front-off, animated front-on, back, side", () => {
    const base = {
      name: 'PC',
      label: 'PC',
      category: 'electronics',
      width: 16,
      height: 32,
      footprintW: 1,
      footprintH: 2,
      isDesk: false,
      canPlaceOnWalls: false,
      groupId: 'PC',
    };
    const manifest: FlattenedAsset[] = [
      { ...base, id: 'PC_FRONT_ON_1', file: 'PC_FRONT_ON_1.png', orientation: 'front', state: 'on', animationGroup: 'PC_FRONT_ON', frame: 0 },
      { ...base, id: 'PC_FRONT_ON_2', file: 'PC_FRONT_ON_2.png', orientation: 'front', state: 'on', animationGroup: 'PC_FRONT_ON', frame: 1 },
      { ...base, id: 'PC_FRONT_ON_3', file: 'PC_FRONT_ON_3.png', orientation: 'front', state: 'on', animationGroup: 'PC_FRONT_ON', frame: 2 },
      { ...base, id: 'PC_FRONT_OFF', file: 'PC_FRONT_OFF.png', orientation: 'front', state: 'off' },
      { ...base, id: 'PC_BACK', file: 'PC_BACK.png', orientation: 'back' },
      { ...base, id: 'PC_SIDE', file: 'PC_SIDE.png', orientation: 'side', mirrorSide: true },
    ];
    const sprites = Object.fromEntries(manifest.map((entry) => [entry.id, grid(`#${entry.id}`)]));

    const poses = buildAssetPoses(furnitureAsset(manifest, sprites));

    expect(poses.map((p) => p.label)).toEqual(['Front · On', 'Front · Off', 'Back', 'Side']);
    const on = poses.find((p) => p.label === 'Front · On');
    expect(on?.frames).toHaveLength(3);
    expect(poses.find((p) => p.label === 'Front · Off')?.frames).toHaveLength(1);
  });

  it('sorts animation-group frames by `frame`, regardless of manifest order', () => {
    const base = {
      name: 'Blinker',
      label: 'Blinker',
      category: 'decor',
      width: 16,
      height: 16,
      footprintW: 1,
      footprintH: 1,
      isDesk: false,
      canPlaceOnWalls: false,
      groupId: 'BLINKER',
      animationGroup: 'BLINKER_ON',
    };
    const manifest: FlattenedAsset[] = [
      { ...base, id: 'BLINKER_3', file: 'BLINKER_3.png', frame: 2 },
      { ...base, id: 'BLINKER_1', file: 'BLINKER_1.png', frame: 0 },
      { ...base, id: 'BLINKER_2', file: 'BLINKER_2.png', frame: 1 },
    ];
    const sprites = {
      BLINKER_1: grid('#111'),
      BLINKER_2: grid('#222'),
      BLINKER_3: grid('#333'),
    };

    const poses = buildAssetPoses(furnitureAsset(manifest, sprites));
    expect(poses).toHaveLength(1);
    expect(poses[0]?.frames).toHaveLength(3);
  });

  it('skips a variant with no matching sprite instead of emitting an empty pose', () => {
    const manifest: FlattenedAsset[] = [
      {
        id: 'GHOST',
        name: 'Ghost',
        label: 'Ghost',
        category: 'decor',
        file: 'GHOST.png',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        canPlaceOnWalls: false,
        groupId: 'GHOST',
      },
    ];
    expect(buildAssetPoses(furnitureAsset(manifest, {}))).toEqual([]);
  });
});

describe('buildAssetPoses — character', () => {
  function frameRow(label: string): string[][][] {
    return Array.from({ length: 7 }, (_, i) => grid(`#${label}${i}`));
  }

  it('gives a walking pose per direction, plus a mirrored left reusing right', () => {
    const frames: CharacterFrames = { down: frameRow('D'), up: frameRow('U'), right: frameRow('R') };
    const poses = buildAssetPoses({ assetKind: 'character', manifest: [{ id: 'CHAR_0' }], sprites: { CHAR_0: frames } });

    expect(poses.map((p) => p.key)).toEqual(['down', 'up', 'right', 'left']);
    const right = poses.find((p) => p.key === 'right');
    const left = poses.find((p) => p.key === 'left');
    expect(left?.mirror).toBe(true);
    expect(left?.frames).toEqual(right?.frames);
    // Only the walk-cycle slice (3 of the 7 frames), not the typing/reading frames too.
    expect(right?.frames).toHaveLength(3);
  });
});

describe('buildAssetPoses — pet', () => {
  function frames(count: number, label: string): string[][][] {
    return Array.from({ length: count }, (_, i) => grid(`#${label}${i}`));
  }

  it('gives a walking pose per direction, plus a mirrored left reusing right', () => {
    const petFrames: PetFrames = {
      walkDown: frames(3, 'D'),
      idleDown: frames(3, 'ID'),
      walkUp: frames(3, 'U'),
      idleUp: frames(3, 'IU'),
      walkRight: frames(3, 'R'),
    };
    const poses = buildAssetPoses({ assetKind: 'pet', manifest: [{ id: 'GITCAT' }], sprites: { GITCAT: petFrames } });

    expect(poses.map((p) => p.key)).toEqual(['down', 'up', 'right', 'left']);
    const left = poses.find((p) => p.key === 'left');
    expect(left?.mirror).toBe(true);
  });

  it('returns nothing for an id with no matching sprite entry', () => {
    const poses = buildAssetPoses({ assetKind: 'pet', manifest: [{ id: 'MISSING' }], sprites: {} });
    expect(poses).toEqual([]);
  });
});
