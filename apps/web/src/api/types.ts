/**
 * Hand-written against `services/api/src/layouts/schemas.ts` — the single
 * source of truth Fastify validates requests/responses against and
 * `@fastify/swagger` derives `/openapi.json` from (#6). Checked, not
 * generated: the API is small enough right now that a generator step would
 * be more ceremony than the two shapes below are worth. If that stops being
 * true, revisit — `LayoutSummary` and `LayoutDetail` are named to match the
 * OpenAPI document's own schema names on purpose, so a future codegen swap
 * doesn't have to rename anything downstream.
 */

export interface PublicAuthor {
  /** The Discord user id (snowflake), not the internal Pixel Index UUID (#61). */
  discordId: string | null;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface LayoutFiles {
  layout: string;
  preview: string;
  thumbnail: string;
}

export interface LayoutSummary {
  slug: string;
  title: string;
  author: PublicAuthor;
  description: string;
  tags: string[];
  cols: number;
  rows: number;
  /** The occupied-footprint width/height — what "size" means to a viewer. `cols`/`rows` is the declared canvas (#55). */
  visibleCols: number;
  visibleRows: number;
  furniture: number;
  areas: number;
  pets: number;
  carpets: number;
  seats: number;
  layoutRevision: number;
  pixelAgentsVersion: string | null;
  bytes: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
  files: LayoutFiles;
}

export interface LayoutDetail extends LayoutSummary {
  layout: unknown;
}

export interface ListLayoutsResponse {
  schemaVersion: number;
  total: number;
  layouts: LayoutSummary[];
  nextCursor: string | null;
}

export interface ListLayoutsParams {
  limit?: number;
  cursor?: string;
  sort?: 'newest' | 'furniture' | 'largest' | 'title';
  /** A Discord user id (snowflake), not the internal Pixel Index UUID (#61). */
  author?: string;
  tags?: string;
  q?: string;
  minCols?: number;
  maxCols?: number;
  minRows?: number;
  maxRows?: number;
  minSize?: number;
  maxSize?: number;
  minFurniture?: number;
  maxFurniture?: number;
  minPets?: number;
  maxPets?: number;
  minSeats?: number;
  maxSeats?: number;
}

export interface MetaResponse {
  schemaVersion: number;
  generatedAt: string;
  /** This checkout's own commit — distinct from pixelAgents.commit below, which is the pinned upstream's. */
  apiCommit: string | null;
  pixelAgents: {
    version: string | null;
    commit: string | null;
    layoutRevision: number;
  };
  count: number;
  discordInviteUrl: string | null;
}

/** `GET /` (#32) — a third-party integrator's entry point into the bare API origin. */
export interface ApiInfo {
  name: string;
  description: string;
  version: string;
  commit: string | null;
  documentation: string;
  openapi: string;
  repository: string;
}

export interface TagUsage {
  name: string;
  count: number;
}

export interface ListTagsResponse {
  schemaVersion: number;
  tags: TagUsage[];
}

// ─── Auth (#7, #15) ──────────────────────────────────────────────────────

export type Role = 'user' | 'moderator' | 'admin';

export interface AuthUser {
  /** Internal UUID — sessions, ownership, moderation. Not a public identifier. */
  id: string;
  /**
   * Discord snowflake, the identifier public author routes are keyed by (#62).
   * The only way to link a logged-in user to their own `/authors/:id` page;
   * null for system users, who have no public profile.
   */
  discordId: string | null;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  role: Role;
  capabilityCheckedAt: string | null;
  capabilityCacheTtlMs: number;
  submission: {
    allowed: boolean;
    reason: 'discord_membership_required' | 'discord_reauthorization_required' | null;
    inviteUrl: string | null;
  };
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresInMs: number;
}

export interface TokenExchangeResponse extends TokenPair {
  user: AuthUser;
}

// ─── Owner self-service (#9, #15) ───────────────────────────────────────

export interface OwnerLayoutView extends LayoutDetail {
  visibility: 'public' | 'hidden' | 'deleted';
  visibilityReason: string | null;
  visibilityChangedAt: string | null;
}

export interface ListOwnerLayoutsResponse {
  schemaVersion: number;
  total: number;
  layouts: OwnerLayoutView[];
  nextCursor: string | null;
}

export interface SubmitLayoutParams {
  title: string;
  description?: string;
  tags?: string;
}

export interface PatchLayoutBody {
  title?: string;
  description?: string;
  tags?: string[];
  /**
   * Owner or moderator, on public/hidden only (#72) — `deleted` is never
   * reachable through PATCH for either actor; see `deleteLayout` instead.
   */
  visibility?: 'public' | 'hidden';
  /** Moderator-only vanity slug (#29) — see manage.ts's PATCH handler. */
  slug?: string;
  reason?: string;
}

// ─── Moderation & admin (#10, #15) ──────────────────────────────────────

export interface ListModerationLayoutsParams {
  limit?: number;
  cursor?: string;
  sort?: 'newest' | 'furniture' | 'largest' | 'title';
  visibility?: 'public' | 'hidden' | 'deleted';
  author?: string;
  q?: string;
}

export interface AdminUserView {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  capability: Role;
  capabilityCheckedAt: string | null;
  layoutCount: number;
}

export interface ListAdminUsersResponse {
  users: AdminUserView[];
  nextCursor: string | null;
}

/** Matches schema.ts's `audit_action` pgEnum, services/api. */
export type AuditAction =
  | 'layout.create'
  | 'layout.update'
  | 'layout.replace'
  | 'layout.delete'
  | 'layout.hide'
  | 'layout.unhide'
  // Retired (#72) — no longer written, kept only so pre-#72 history renders.
  | 'layout.remove'
  | 'layout.restore'
  | 'layout.moderate_edit'
  | 'layout.rename_slug'
  | 'report.create'
  | 'report.resolve'
  | 'report.dismiss';

/** One row of `GET /api/v1/admin/moderation-actions` — admin-only (#29 follow-up). */
export interface AuditLogEntry {
  id: string;
  action: AuditAction;
  targetType: 'layout' | 'user' | 'report';
  targetId: string;
  actorUserId: string | null;
  actorLabel: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
  /** Resolved from the target's CURRENT slug/title, not what `before`/`after` mentions — null for a non-layout target. */
  layoutSlug: string | null;
  layoutTitle: string | null;
}

export interface ListAuditLogResponse {
  actions: AuditLogEntry[];
  nextCursor: string | null;
}

export interface ListAuditLogParams {
  limit?: number;
  cursor?: string;
  /** Exact — the layout's current slug. */
  slug?: string;
  /** Broad search across the current layout's slug/title. */
  q?: string;
  action?: AuditAction;
}

export interface PublicAuthorResponse {
  schemaVersion: number;
  author: PublicAuthor;
  publicLayoutCount: number;
}

// ─── Custom assets (#101) ────────────────────────────────────────────────

export interface AssetFiles {
  sprite: string;
}

export interface AssetSummary {
  assetId: string;
  /** #105: furniture, character, or pet — a character/pet row has a null `category`. */
  assetKind: 'furniture' | 'character' | 'pet';
  name: string;
  category: string | null;
  /** `'builtin'` for the catalog bundled with Pixel Agents itself, `'custom'` for a community upload. */
  source: 'builtin' | 'custom';
  author: PublicAuthor;
  /**
   * Real, user-facing classifiers — orientation (furniture only:
   * front/back/left/right/side), static/animated (every asset has at least
   * one, can have both), interactable (furniture only). Replaces the removed
   * `variantCount` field, which was just a count of internal
   * flattened-manifest leaves.
   */
  tags: string[];
  createdAt: string;
  updatedAt: string;
  files: AssetFiles;
}

/** `manifest` is pixel-agents' own flattened `CatalogEntry[]` shape — opaque here, same treatment `LayoutDetail.layout` gets. */
export interface AssetDetail extends AssetSummary {
  manifest: unknown[];
}

/** One visually distinct variant of an asset — a furniture orientation/state, or a character/pet facing. */
export interface AssetPose {
  key: string;
  label: string;
  /** Show this pose's frames horizontally mirrored — a "left" pose reusing "right"'s own frames. */
  mirror?: boolean;
  /** `data:image/png;base64,...` — always at least one, in playback order. */
  frames: string[];
}

export interface AssetFramesResponse {
  schemaVersion: number;
  poses: AssetPose[];
}

export interface ListAssetsResponse {
  schemaVersion: number;
  total: number;
  assets: AssetSummary[];
  nextCursor: string | null;
}

export interface ListAssetsParams {
  limit?: number;
  cursor?: string;
  assetKind?: 'furniture' | 'character' | 'pet';
  category?: string;
  source?: 'builtin' | 'custom';
  /** A Discord user id (snowflake), same convention as ListLayoutsParams.author. */
  author?: string;
  /** The tag facet filter (assets/tags.ts server-side) — OR within each facet, AND across the facets present. */
  orientation?: string[];
  animation?: string[];
  interactable?: boolean;
}

export interface SubmitAssetParams {
  name: string;
  /**
   * #105: required by the API. This app only ever uploads furniture today —
   * character/pet upload UI is a follow-up, not part of this change.
   */
  assetKind: 'furniture';
  category: string;
}
