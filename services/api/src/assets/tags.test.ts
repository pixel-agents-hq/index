import { describe, expect, it } from 'vitest';

import type { FlattenedAsset } from './manifest.js';
import { facingAssetTags, furnitureTags } from './tags.js';

function leaf(overrides: Partial<FlattenedAsset> = {}): FlattenedAsset {
  return {
    id: 'X',
    name: 'X',
    label: 'X',
    category: 'electronics',
    file: 'X.png',
    width: 16,
    height: 16,
    footprintW: 1,
    footprintH: 1,
    isDesk: false,
    canPlaceOnWalls: false,
    groupId: 'X',
    ...overrides,
  };
}

describe('furnitureTags', () => {
  it('tags PC as both static and animated, interactable, and every orientation present', () => {
    // The reference example the owner cited: 'off' is a single static leaf,
    // 'on' is a 3-frame animationGroup — both states carry a `state` field,
    // so the asset is also interactable.
    const manifest: FlattenedAsset[] = [
      leaf({ id: 'PC_FRONT_ON_1', orientation: 'front', state: 'on', animationGroup: 'PC_FRONT_ON', frame: 0 }),
      leaf({ id: 'PC_FRONT_ON_2', orientation: 'front', state: 'on', animationGroup: 'PC_FRONT_ON', frame: 1 }),
      leaf({ id: 'PC_FRONT_ON_3', orientation: 'front', state: 'on', animationGroup: 'PC_FRONT_ON', frame: 2 }),
      leaf({ id: 'PC_FRONT_OFF', orientation: 'front', state: 'off' }),
      leaf({ id: 'PC_BACK', orientation: 'back' }),
      leaf({ id: 'PC_SIDE', orientation: 'side', mirrorSide: true }),
    ];

    expect(furnitureTags(manifest).sort()).toEqual(
      ['front', 'back', 'side', 'static', 'animated', 'interactable'].sort(),
    );
  });

  it('tags a single static, non-interactable asset with only its orientation and "static"', () => {
    const manifest: FlattenedAsset[] = [leaf({ id: 'CHAIR', orientation: 'front' })];
    expect(furnitureTags(manifest).sort()).toEqual(['front', 'static'].sort());
  });

  it('tags a fully-animated asset with no state field as animated but not interactable', () => {
    const manifest: FlattenedAsset[] = [
      leaf({ id: 'FAN_1', orientation: 'front', animationGroup: 'FAN', frame: 0 }),
      leaf({ id: 'FAN_2', orientation: 'front', animationGroup: 'FAN', frame: 1 }),
    ];
    expect(furnitureTags(manifest).sort()).toEqual(['front', 'animated'].sort());
  });

  it('does not tag an orientation value outside the fixed vocabulary', () => {
    // The published manifest schema leaves `orientation` unconstrained, so a
    // custom uploader could write anything — an unrecognized value is
    // silently dropped rather than surfaced as a bogus tag.
    const manifest: FlattenedAsset[] = [leaf({ id: 'WEIRD', orientation: 'diagonal' })];
    expect(furnitureTags(manifest)).toEqual(['static']);
  });

  it('has no orientation or interactable tags when no leaf carries either field', () => {
    const manifest: FlattenedAsset[] = [leaf({ id: 'MISC' })];
    expect(furnitureTags(manifest)).toEqual(['static']);
  });
});

describe('facingAssetTags', () => {
  it('is always exactly ["animated"] — characters/pets always decode to a multi-frame walk cycle', () => {
    expect(facingAssetTags()).toEqual(['animated']);
  });
});
