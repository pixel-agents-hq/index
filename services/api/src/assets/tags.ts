/**
 * Real, user-facing semantic tags for a custom asset — replaces `variantCount`
 * as the primary classifier a gallery card shows (variantCount is just a
 * count of internal flattened-manifest leaves, an implementation-pipeline
 * artifact, not something a viewer looking at one furniture item can
 * interpret). See the PR description for the full design discussion.
 *
 * Furniture-only facets (orientation, interactable) stay furniture-only
 * because both would otherwise tag every single character/pet identically —
 * the exact "meaningless classifier" problem this file exists to fix:
 *
 * - Orientation: `manifest.ts`'s `FlattenedAsset.orientation` uses exactly
 *   the fixed front/back/left/right/side vocabulary
 *   `docs/external-assets.md`'s "Member orientation values" section
 *   documents for furniture. A character/pet manifest entry
 *   (`decodeCharacter.ts`'s `CharacterManifestEntry`, `decodePet.ts`'s
 *   `PetManifestEntry`) has no orientation field at all — its walk cycle
 *   always covers all four directions (down/up/right, mirrored to left),
 *   identically for every character and pet ever uploaded, so tagging every
 *   one with all four would carry zero information.
 * - Interactable: a leaf with a `state` field (furniture's on/off toggle
 *   concept — PC's `off`/`on` states are the reference example, see
 *   manifest.ts's FlattenedAsset doc comment). `CharacterManifestEntry` and
 *   `PetManifestEntry` carry no `state` field at all, so this is
 *   structurally impossible for either kind.
 *
 * static/animated applies to all three kinds: `decodeCharacterPng`
 * (decodeCharacter.ts) and `decodePetPng` (decodePet.ts) always produce a
 * full multi-frame walk cycle — neither has a single-frame code path — so
 * every character and pet is unconditionally 'animated' and never 'static'.
 * Furniture instead reflects each flattened leaf's own `animationGroup`
 * presence, so one asset (e.g. PC) can be tagged both.
 */

import type { FlattenedAsset } from './manifest.js';

export const FURNITURE_ORIENTATION_TAGS = ['front', 'back', 'left', 'right', 'side'] as const;
export type FurnitureOrientationTag = (typeof FURNITURE_ORIENTATION_TAGS)[number];

export const ANIMATION_TAGS = ['static', 'animated'] as const;
export type AnimationTag = (typeof ANIMATION_TAGS)[number];

export const INTERACTABLE_TAG = 'interactable';

const ORIENTATION_SET: ReadonlySet<string> = new Set(FURNITURE_ORIENTATION_TAGS);

/**
 * A furniture asset's tags, derived from its flattened manifest leaves.
 *
 * An orientation value outside the fixed vocabulary is silently not tagged
 * rather than rejected — the published manifest schema
 * (`custom-asset-furniture-manifest.schema.json`) leaves `orientation`
 * unconstrained, so a custom uploader can in principle write anything there.
 */
export function furnitureTags(manifest: readonly FlattenedAsset[]): string[] {
  const tags = new Set<string>();
  for (const leaf of manifest) {
    if (leaf.orientation && ORIENTATION_SET.has(leaf.orientation)) tags.add(leaf.orientation);
    tags.add(leaf.animationGroup ? 'animated' : 'static');
    if (leaf.state) tags.add(INTERACTABLE_TAG);
  }
  return [...tags];
}

/** A character or pet's tags — see the file header for why this is always exactly `['animated']`. */
export function facingAssetTags(): string[] {
  return ['animated'];
}
