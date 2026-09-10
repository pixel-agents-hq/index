/**
 * The external-asset manifest schema pixel-agents' own VS Code extension
 * already defines (`docs/external-assets.md`) — `type: asset | group`,
 * rotation/state/animation groups, orientation members.
 *
 * This is a deliberate, hand-kept LOCAL copy of
 * `vendor/pixel-agents/core/src/assets/manifestUtils.ts`'s types and
 * `flattenManifest()`, not an import of it: `tsconfig.build.json` pins
 * `rootDir: "src"`, so a static import reaching outside it (into the vendor
 * git submodule) would fail the build. `packages/layout-core/src/upstream.ts`
 * established the same answer for the same reason — read the pinned
 * upstream's *shape* at the boundary, never cross it with a module import.
 * Keep this in sync with upstream's `manifestUtils.ts` by hand if that format
 * ever changes.
 *
 * `validateManifestShape()` below is the one exception to "hand-written" —
 * it compiles and runs the published
 * `custom-asset-furniture-manifest.schema.json` contract (#107) instead of
 * duplicating its own checks, specifically so this file's actual runtime
 * enforcement and the schema pixel-art-mcp validates against cannot drift
 * apart from each other.
 */

import { customAssetFurnitureManifestSchema, withFormats } from '@pixel-index/layout-core';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

import { issuesFromAjvErrors } from './zip.js';

export interface ManifestAsset {
  type: 'asset';
  id: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  orientation?: string;
  state?: string;
  frame?: number;
  mirrorSide?: boolean;
}

export interface ManifestGroup {
  type: 'group';
  groupType: 'rotation' | 'state' | 'animation';
  rotationScheme?: string;
  orientation?: string;
  state?: string;
  members: ManifestNode[];
}

export type ManifestNode = ManifestAsset | ManifestGroup;

export interface FurnitureManifest {
  id: string;
  name: string;
  category: string;
  canPlaceOnWalls?: boolean;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  type: 'asset' | 'group';
  file?: string;
  width?: number;
  height?: number;
  footprintW?: number;
  footprintH?: number;
  groupType?: string;
  rotationScheme?: string;
  members?: ManifestNode[];
}

interface InheritedProps {
  groupId: string;
  name: string;
  category: string;
  canPlaceOnWalls: boolean;
  canPlaceOnSurfaces: boolean;
  backgroundTiles: number;
  orientation?: string;
  state?: string;
  rotationScheme?: string;
  animationGroup?: string;
}

/** One leaf variant of a manifest — what actually needs a decoded PNG. */
export interface FlattenedAsset {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  groupId: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
}

/**
 * Recursively flattens a manifest tree into its leaf variants, exactly as
 * upstream's `flattenManifest` does — inherited properties flow from the
 * group root down to every leaf asset.
 */
export function flattenManifest(node: ManifestNode, inherited: InheritedProps): FlattenedAsset[] {
  if (node.type === 'asset') {
    const orientation = node.orientation ?? inherited.orientation;
    const state = node.state ?? inherited.state;
    return [
      {
        id: node.id,
        name: inherited.name,
        label: inherited.name,
        category: inherited.category,
        file: node.file,
        width: node.width,
        height: node.height,
        footprintW: node.footprintW,
        footprintH: node.footprintH,
        isDesk: inherited.category === 'desks',
        canPlaceOnWalls: inherited.canPlaceOnWalls,
        canPlaceOnSurfaces: inherited.canPlaceOnSurfaces,
        backgroundTiles: inherited.backgroundTiles,
        groupId: inherited.groupId,
        ...(orientation ? { orientation } : {}),
        ...(state ? { state } : {}),
        ...(node.mirrorSide ? { mirrorSide: true } : {}),
        ...(inherited.rotationScheme ? { rotationScheme: inherited.rotationScheme } : {}),
        ...(inherited.animationGroup ? { animationGroup: inherited.animationGroup } : {}),
        ...(node.frame !== undefined ? { frame: node.frame } : {}),
      },
    ];
  }

  const results: FlattenedAsset[] = [];
  for (const member of node.members) {
    const childProps: InheritedProps = { ...inherited };

    if (node.groupType === 'rotation' && node.rotationScheme) {
      childProps.rotationScheme = node.rotationScheme;
    }
    if (node.groupType === 'state') {
      if (node.orientation) childProps.orientation = node.orientation;
      if (node.state) childProps.state = node.state;
    }
    if (node.groupType === 'animation') {
      const orient = node.orientation ?? inherited.orientation ?? '';
      const st = node.state ?? inherited.state ?? '';
      childProps.animationGroup = `${inherited.groupId}_${orient}_${st}`.toUpperCase();
      if (node.state) childProps.state = node.state;
    }
    if (node.orientation && !childProps.orientation) childProps.orientation = node.orientation;

    results.push(...flattenManifest(member, childProps));
  }
  return results;
}

/**
 * The id character set both the manifest doc and pixel-art-mcp's own
 * `asset_id` option require: uppercase letters, digits, underscore, starting
 * with a letter. Enforced at the database level too (`custom_assets_asset_id_format`).
 */
export const ASSET_ID_RE = /^[A-Z][A-Z0-9_]*$/;

export interface ManifestIssue {
  path: string;
  message: string;
}

const ajv = withFormats(new Ajv2020({ allErrors: true, strict: false }));
const validate: ValidateFunction = ajv.compile(customAssetFurnitureManifestSchema);

/**
 * Structural validation only — does this look like a `FurnitureManifest`?
 * Validates against the published contract
 * (`packages/layout-core/schema/custom-asset-furniture-manifest.schema.json`,
 * #107) rather than hand-written checks, so runtime enforcement and the
 * published schema can't drift apart again the way they had before #107
 * published the schema without wiring decode to it.
 *
 * PNG presence/dimensions are checked separately once the zip is unpacked.
 */
export function validateManifestShape(value: unknown): { manifest: FurnitureManifest } | { issues: ManifestIssue[] } {
  if (!validate(value)) {
    return { issues: issuesFromAjvErrors(validate.errors) };
  }
  return { manifest: value as FurnitureManifest };
}
