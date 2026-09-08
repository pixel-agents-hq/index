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
 */

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

const VALID_CATEGORIES = new Set([
  'desks',
  'chairs',
  'electronics',
  'storage',
  'decor',
  'misc',
  'wall',
]);

export interface ManifestIssue {
  path: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural validation only — does this look like a `FurnitureManifest`?
 * PNG presence/dimensions are checked separately once the zip is unpacked.
 */
export function validateManifestShape(value: unknown): { manifest: FurnitureManifest } | { issues: ManifestIssue[] } {
  const issues: ManifestIssue[] = [];
  if (!isRecord(value)) return { issues: [{ path: '/', message: 'manifest.json must be a JSON object.' }] };

  const id = value.id;
  if (typeof id !== 'string' || !ASSET_ID_RE.test(id)) {
    issues.push({
      path: '/id',
      message: 'id must start with an uppercase letter and contain only A-Z, 0-9, underscore.',
    });
  }
  if (typeof value.name !== 'string' || value.name.trim() === '') {
    issues.push({ path: '/name', message: 'name is required.' });
  }
  if (typeof value.category !== 'string' || !VALID_CATEGORIES.has(value.category)) {
    issues.push({
      path: '/category',
      message: `category must be one of: ${[...VALID_CATEGORIES].join(', ')}.`,
    });
  }
  if (value.type !== 'asset' && value.type !== 'group') {
    issues.push({ path: '/type', message: 'type must be "asset" or "group".' });
  }

  if (value.type === 'asset') {
    for (const field of ['file', 'width', 'height', 'footprintW', 'footprintH'] as const) {
      const present = field === 'file' ? typeof value[field] === 'string' : typeof value[field] === 'number';
      if (!present) issues.push({ path: `/${field}`, message: `${field} is required for an asset manifest.` });
    }
  } else if (value.type === 'group') {
    if (!Array.isArray(value.members) || value.members.length === 0) {
      issues.push({ path: '/members', message: 'a group manifest needs at least one member.' });
    } else {
      for (const [index, member] of value.members.entries()) {
        const memberIssues = validateNodeShape(member, `/members/${index}`);
        issues.push(...memberIssues);
      }
    }
  }

  if (issues.length > 0) return { issues };
  return { manifest: value as unknown as FurnitureManifest };
}

function validateNodeShape(value: unknown, path: string): ManifestIssue[] {
  if (!isRecord(value)) return [{ path, message: 'must be an object.' }];
  const issues: ManifestIssue[] = [];
  if (value.type !== 'asset' && value.type !== 'group') {
    issues.push({ path: `${path}/type`, message: 'type must be "asset" or "group".' });
    return issues;
  }
  if (value.type === 'asset') {
    if (typeof value.id !== 'string' || !ASSET_ID_RE.test(value.id)) {
      issues.push({ path: `${path}/id`, message: 'invalid or missing id.' });
    }
    for (const field of ['file', 'width', 'height', 'footprintW', 'footprintH'] as const) {
      const present = field === 'file' ? typeof value[field] === 'string' : typeof value[field] === 'number';
      if (!present) issues.push({ path: `${path}/${field}`, message: `${field} is required.` });
    }
  } else {
    if (!Array.isArray(value.members) || value.members.length === 0) {
      issues.push({ path: `${path}/members`, message: 'a group needs at least one member.' });
    } else {
      for (const [index, member] of value.members.entries()) {
        issues.push(...validateNodeShape(member, `${path}/members/${index}`));
      }
    }
  }
  return issues;
}
