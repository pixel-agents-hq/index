/**
 * @pixel-index/layout-core — the single definition of what a valid layout is.
 *
 * Three components need this answer: CI, the API's submission endpoint (#8) and
 * the renderer (#4). Three copies would drift, and a drifted validator means the
 * index accepts a layout Pixel Agents will silently discard — the specific
 * failure this project exists to prevent.
 *
 * The library takes parsed objects, never paths, so a server can validate an
 * uploaded request body. Reading the *pinned upstream* from disk is the one
 * exception, because the furniture catalog and the bundled layoutRevision have
 * to come from somewhere.
 */

export { withFormats } from './ajv.js';
export { layoutSchema, metaSchema, SCHEMA_DIR } from './schemas.js';
export {
  layoutStats,
  type LayoutStatsOptions,
  occupiedBounds,
  sha256,
  type TileBounds,
} from './stats.js';
export type {
  Area,
  FurnitureCatalog,
  FurnitureEntry,
  FurnitureItem,
  IssueCode,
  Layout,
  LayoutMeta,
  LayoutStats,
  UpstreamPin,
  ValidationIssue,
  ValidationResult,
} from './types.js';
export {
  assertUpstream,
  bundledLayoutRevision,
  furnitureCatalog,
  knownFurnitureIds,
  mergeFurnitureCatalog,
  readJsonOrNull,
  resolveUpstreamDir,
  UPSTREAM_ENV_VAR,
  upstreamAssetsDir,
  upstreamCommitFile,
  upstreamPin,
} from './upstream.js';
export {
  createValidator,
  SLUG_RE,
  validateLayout,
  type ValidateLayoutOptions,
  validateMeta,
  validateSlug,
  type Validator,
} from './validate.js';
