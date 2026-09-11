/**
 * Everything that reads the pinned Pixel Agents checkout.
 *
 * The upstream directory is resolved once, here, so `vendor/pixel-agents` is
 * referenced in exactly one place — and it is a parameter rather than a
 * constant, because the API and the renderer run from containers whose layout on
 * disk is nothing like the repo's.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FurnitureCatalog, FurnitureEntry, UpstreamPin } from './types.js';

/**
 * Extends a furniture catalog with additional entries (#101's custom,
 * uploaded furniture) — a plain `Map` copy-and-set, not a re-read of the
 * upstream asset tree, so it is cheap enough to do per request. Used by both
 * the API (submission/replace validation) and the renderer (its own
 * validation before ever handing a layout to Chromium) so a layout
 * referencing a published custom asset validates the same way in both
 * places.
 */
export function mergeFurnitureCatalog(
  base: FurnitureCatalog,
  extra: Iterable<{ id: string } & FurnitureEntry>,
): FurnitureCatalog {
  const merged = new Map(base);
  for (const { id, ...props } of extra) {
    merged.set(id, props);
  }
  return merged;
}

export const UPSTREAM_ENV_VAR = 'PIXEL_AGENTS_DIR';

/**
 * Locate the pinned upstream: an explicit argument wins, then
 * `PIXEL_AGENTS_DIR`, then the nearest `vendor/pixel-agents` above this module.
 *
 * Walking up rather than hardcoding a relative path keeps this working from
 * `src/` under vitest, from `dist/` after a build, and from wherever npm hoists
 * the package inside a container.
 */
export function resolveUpstreamDir(explicit?: string): string {
  if (explicit) return path.resolve(explicit);

  const fromEnv = process.env[UPSTREAM_ENV_VAR];
  if (fromEnv) return path.resolve(fromEnv);

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = path.join(dir, 'vendor/pixel-agents');
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Nothing found — return the conventional location so assertUpstream() can
  // produce the actionable "run git submodule update" message.
  return path.resolve('vendor/pixel-agents');
}

export function upstreamAssetsDir(upstreamDir?: string): string {
  return path.join(resolveUpstreamDir(upstreamDir), 'webview-ui/public/assets');
}

export function assertUpstream(upstreamDir?: string): void {
  const dir = resolveUpstreamDir(upstreamDir);
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    throw new Error(
      `Pinned Pixel Agents not found at ${dir}. ` +
        'Run: git submodule update --init --recursive ' +
        `(or set ${UPSTREAM_ENV_VAR}).`,
    );
  }
}

/**
 * Parse a JSON file, or `null` if it is missing or malformed.
 *
 * `T` is used once, which is `no-unnecessary-type-parameters`' definition of a
 * type parameter that is really an assertion — and the rule is right. It is
 * kept because the alternative is worse: dropping it moves a bare `as` to all
 * five call sites, and the shape (`response.json<T>()` in Fastify, `res.json()`
 * in fetch) is the conventional one for "parse this and tell me what you expect".
 * Making it return `unknown` and validating at each site is the honest long-term
 * answer; one of those sites is a recursive furniture manifest, so it is its own
 * piece of work rather than a lint fix.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function readJsonOrNull<T = unknown>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/**
 * The revision of the default layout bundled with the pinned upstream.
 *
 * This is the number every published layout is measured against: Pixel Agents
 * throws away a stored layout whose revision is BELOW the bundled default's
 * (server/src/layoutPersistence.ts), so a layout published under this number is
 * one that silently resets on the user's next start.
 */
export function bundledLayoutRevision(upstreamDir?: string): number {
  assertUpstream(upstreamDir);
  const assets = upstreamAssetsDir(upstreamDir);
  const candidates = fs
    .readdirSync(assets)
    .map((file) => /^default-layout-(\d+)\.json$/.exec(file))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ revision: Number(match[1]), file: match[0] }))
    .sort((a, b) => b.revision - a.revision);

  const newest = candidates[0];
  if (!newest) return 0;

  const layout = readJsonOrNull<{ layoutRevision?: number }>(path.join(assets, newest.file));
  return layout?.layoutRevision ?? newest.revision;
}

/** Properties a manifest group passes down to its members. */
const INHERITED_PROPS = [
  'category',
  'canPlaceOnWalls',
  'canPlaceOnSurfaces',
  'backgroundTiles',
  'footprintW',
  'footprintH',
] as const;

interface ManifestNode {
  type?: string;
  id?: string;
  orientation?: string;
  mirrorSide?: boolean;
  members?: ManifestNode[];
  [key: string]: unknown;
}

/**
 * Every furniture id the pinned upstream can draw, as id -> placement props.
 *
 * Two shapes have to be handled or valid layouts get flagged:
 *
 * - Manifests are trees. `canPlaceOnWalls` and the footprint often sit on the
 *   group root and are inherited by the leaf assets (see PC, CLOCK).
 * - `mirrorSide` assets with orientation "side" gain a virtual `<id>:left`
 *   entry in the catalog, and layouts store that id verbatim
 *   (webview-ui/src/office/layout/furnitureCatalog.ts).
 */
export function furnitureCatalog(upstreamDir?: string): FurnitureCatalog {
  assertUpstream(upstreamDir);
  const furnitureDir = path.join(upstreamAssetsDir(upstreamDir), 'furniture');
  const catalog: FurnitureCatalog = new Map();
  if (!fs.existsSync(furnitureDir)) return catalog;

  for (const entry of fs.readdirSync(furnitureDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = readJsonOrNull<ManifestNode>(
      path.join(furnitureDir, entry.name, 'manifest.json'),
    );
    if (manifest) walkManifest(manifest, {}, catalog);
  }

  for (const [id, props] of [...catalog]) {
    if (props.mirrorSide && props.orientation === 'side') {
      catalog.set(`${id}:left`, { ...props, orientation: 'left' });
    }
  }
  return catalog;
}

function walkManifest(
  node: ManifestNode | null | undefined,
  inherited: FurnitureEntry,
  catalog: FurnitureCatalog,
): void {
  if (!node || typeof node !== 'object') return;

  const props: FurnitureEntry = { ...inherited };
  for (const key of INHERITED_PROPS) {
    if (node[key] !== undefined) {
      (props as Record<string, unknown>)[key] = node[key];
    }
  }

  if (node.type === 'asset' && typeof node.id === 'string') {
    // `props` already carries the inherited orientation, so the node's own
    // orientation is only spread in when it actually has one. Written as a
    // conditional spread rather than `node.orientation ?? inherited.orientation`
    // so an orientation-less asset leaves the key absent instead of present-and-
    // undefined, which is what exactOptionalPropertyTypes asks for.
    catalog.set(node.id, {
      ...props,
      ...(node.orientation !== undefined ? { orientation: node.orientation } : {}),
      mirrorSide: node.mirrorSide ?? false,
    });
    return;
  }

  // Orientation and state are set on intermediate groups too, and members
  // inherit whatever their enclosing group declared.
  if (node.orientation !== undefined) props.orientation = node.orientation;

  for (const member of node.members ?? []) {
    walkManifest(member, props, catalog);
  }
}

/** Convenience for callers that only need membership. */
export function knownFurnitureIds(upstreamDir?: string): Set<string> {
  return new Set(furnitureCatalog(upstreamDir).keys());
}

/**
 * Every distinct category any bundled furniture manifest actually declares,
 * sorted. Derived from `furnitureCatalog()` rather than a hand-typed list —
 * upstream has no enforced category enum of its own (`category` is a bare
 * string throughout `core/`), so "the current real set" is only knowable by
 * reading what the pinned manifests actually use, not by mirroring a
 * declared-but-partly-unused palette list from the (unimportable) webview
 * layer. Not every category the upstream UI palette supports is guaranteed
 * to appear here — only ones at least one bundled asset actually uses.
 */
export function furnitureCategories(upstreamDir?: string): string[] {
  const categories = new Set<string>();
  for (const entry of furnitureCatalog(upstreamDir).values()) {
    if (entry.category) categories.add(entry.category);
  }
  return [...categories].sort();
}

/**
 * The committed record of which upstream commit `vendor/pixel-agents` pins.
 *
 * A sibling of the checkout, not a file inside it: anything written *into* the
 * submodule shows up as dirty in the submodule and untracked in the parent,
 * which is exactly the kind of permanent noise nobody thanks you for.
 * `/app/vendor/pixel-agents` -> `/app/vendor/pixel-agents.commit`, the same
 * rule in the repo and in a container, so there is one path to reason about.
 */
export function upstreamCommitFile(upstreamDir?: string): string {
  return `${resolveUpstreamDir(upstreamDir)}.commit`;
}

/**
 * Read that record. `null` if absent or malformed — never a guess.
 */
function stampedCommit(dir: string): string | null {
  try {
    const raw = fs.readFileSync(`${dir}.commit`, 'utf-8').trim();
    return /^[0-9a-f]{40}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Which upstream this is: version, commit, and the bundled layout revision.
 *
 * The commit is resolved from git when git can answer, and from the stamp file
 * when it cannot. That second path is not a nicety — it is the *only* one that
 * works in a container. `vendor/pixel-agents/.git` is a gitdir *pointer* whose
 * target lives outside the Docker build context (and, under a git worktree, at
 * an absolute path belonging to another machine entirely), so a copied vendor
 * tree can never resolve its own commit however much of it you copy.
 *
 * This used to be a `PIXEL_AGENTS_COMMIT` build argument the operator had to
 * remember to pass. Nobody remembered, so every deployed image reported
 * `commit: null` — which silently degraded the renderer's cache key to the
 * version alone (and the pin routinely sits several commits past a tag, so two
 * different builds shared cached previews) and left the index unable to say
 * which upstream it was actually serving. A file that ships with the repo and
 * is verified by CI cannot be forgotten.
 */
export function upstreamPin(upstreamDir?: string): UpstreamPin {
  const dir = resolveUpstreamDir(upstreamDir);
  assertUpstream(dir);
  const pkg = readJsonOrNull<{ version?: string }>(path.join(dir, 'package.json'));

  // Ask git rather than reading .git/HEAD: this repo may itself be a submodule,
  // in which case the gitdir lives somewhere else entirely.
  let commit: string | null = null;
  try {
    commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    /* not a git checkout (a container, a release tarball) — the stamp answers */
  }
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) commit = stampedCommit(dir);

  return {
    version: pkg?.version ?? null,
    commit,
    layoutRevision: bundledLayoutRevision(dir),
  };
}
