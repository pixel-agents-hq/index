/**
 * The Pixel Index database schema.
 *
 * Every backend issue after this one is endpoints over these tables, so the
 * decisions that are awkward to change later are made here and explained here:
 *
 * - **Post-moderation.** `visibility` defaults to `public` on insert. There is no
 *   approval queue; the queue is the *report* queue.
 * - **Seed layouts have a real owner.** #18 loads git-versioned layouts that have
 *   no Discord account behind them. Rather than a nullable owner (which would
 *   force every permission check and join to handle null), they belong to a
 *   synthetic system user, with `author_display` carrying the human credit.
 * - **The audit log is append-only in the database**, not by convention. A
 *   trigger rejects UPDATE and DELETE, so "no update/delete path in application
 *   code" cannot rot into "someone added one".
 * - **Stats are denormalised from `@pixel-index/layout-core`.** `layoutStats()`
 *   is the single source of truth and is applied on every write, so a number in
 *   the gallery can never disagree with the layout beside it.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Postgres full-text search vector. Drizzle has no built-in for it. */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ── Enums ─────────────────────────────────────────────────────────────────

export const userRole = pgEnum('user_role', ['user', 'moderator', 'admin']);

/**
 * Why three states rather than a boolean:
 *
 * | state     | set by             | reversible | slug reserved | in public API |
 * |-----------|--------------------|------------|---------------|---------------|
 * | `public`  | —                  | —          | yes           | yes           |
 * | `hidden`  | owner or moderator | yes        | yes           | no            |
 * | `deleted` | owner or moderator | no         | yes           | no            |
 *
 * `deleted` is the single "gone for good" state (#72). There used to be a
 * separate moderator-only `removed`, but a moderator now reaches the exact
 * same irreversible outcome an owner does, through the same `DELETE`
 * endpoint (`manage.ts`), rather than a second value meaning the same thing
 * under a different name depending on who acted. A byte-identical resubmit
 * is allowed once a layout is `deleted`, even one a moderator deleted, same
 * as an owner's own self-delete — abuse of that is a Discord-membership
 * problem (losing submission rights), not something this enum enforces.
 *
 * `hidden` is reversible by either actor: a moderator can hide/unhide
 * anyone's layout (with a reason), and an owner can toggle their own layout
 * between public and hidden — including undoing a moderator's hide — with
 * no reason needed, since it is not a moderation action on their own content.
 *
 * The row always survives. Slugs stay reserved because slug reuse by a
 * different author is a quiet impersonation vector, and because the audit log
 * must keep pointing at something.
 */
export const layoutVisibility = pgEnum('layout_visibility', [
  'public',
  'hidden',
  'deleted',
]);

export const reportReason = pgEnum('report_reason', [
  'hate_symbol',
  'harassment',
  'sexual_content',
  'impersonation',
  'spam',
  'other',
]);

export const reportStatus = pgEnum('report_status', ['open', 'resolved', 'dismissed']);

export const auditTargetType = pgEnum('audit_target_type', ['layout', 'user', 'report']);

/**
 * Everything privileged that can happen, including owner actions — #9 requires
 * owner edits in the same log as moderator ones, so a layout's history is
 * reconstructable from this table alone.
 */
export const auditAction = pgEnum('audit_action', [
  'layout.create',
  'layout.update',
  'layout.replace',
  'layout.delete',
  'layout.hide',
  'layout.unhide',
  /**
   * Retired (#72): no code path writes these anymore — `removed` was folded
   * into `deleted`, so a moderator now records `layout.delete` like an owner
   * does. Kept in the enum only because the append-only audit log is never
   * rewritten; historical rows from before #72 still use them.
   */
  'layout.remove',
  'layout.restore',
  'layout.moderate_edit',
  /** Moderator-only (#29): a vanity slug assigned or changed via manage.ts's PATCH. */
  'layout.rename_slug',
  /**
   * Admin-only (#63): one row per layout created or overwritten by
   * `POST /api/v1/admin/backup/import`. Distinguishable from `layout.create` /
   * `layout.replace` because a bulk restore is a different kind of event to
   * audit than an individual owner's submission or edit, even when the
   * resulting row looks the same.
   */
  'layout.import',
  'report.create',
  'report.resolve',
  'report.dismiss',
]);

/** Persistent outbound work: a delivery survives API restarts until it succeeds or exhausts retries. */
export const webhookDeliveryStatus = pgEnum('webhook_delivery_status', [
  'pending',
  'retrying',
  'succeeded',
  'failed',
  'cancelled',
]);

// ── Tables ────────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The identity. Null only for the synthetic system user used by legacy
     * seed layouts — everything else about a user is cached Discord display data
     * that is allowed to go stale.
     */
    discordId: text('discord_id'),
    /** Stable account handle from Discord's `identify` scope. */
    username: text('username').notNull(),
    /** Nullable global display name from Discord. */
    globalName: text('global_name'),
    /** Nickname in the configured Pixel Index guild, when membership was last verified. */
    guildNickname: text('guild_nickname'),
    avatarUrl: text('avatar_url'),

    /** Last successfully derived capability cache; Discord/config is authoritative. */
    role: userRole('role').notNull().default('user'),

    /** Null until this account has been checked against a configured guild. */
    discordGuildMember: boolean('discord_guild_member'),
    discordMembershipCheckedAt: timestamp('discord_membership_checked_at', {
      withTimezone: true,
    }),

    /** Marks the seed owner. Excluded from user listings; cannot log in. */
    isSystem: boolean('is_system').notNull().default(false),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('users_discord_id_key').on(table.discordId),
    index('users_role_idx').on(table.role),
    // A real account must have a Discord id; only system users may lack one.
    check(
      'users_discord_id_required',
      sql`(${table.isSystem} = true) OR (${table.discordId} IS NOT NULL)`,
    ),
    check('users_system_cannot_login', sql`(${table.isSystem} = false) OR (${table.discordId} IS NULL)`),
  ],
);

export const layouts = pgTable(
  'layouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    slug: text('slug').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),

    /**
     * Always set. Bundled seeds use their real Discord-backed author. Legacy
     * or custom seeds may point at the system user and use `authorDisplay`.
     */
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    authorDisplay: text('author_display'),

    /**
     * The exact bytes as uploaded or seeded, verbatim. This — not `layout` — is
     * what `GET /layouts/:slug/download` serves and what `sha256` is computed
     * over (#6). Postgres's `jsonb` type does not round-trip byte-identically:
     * it can reorder nothing, but it does collapse whitespace and normalise
     * number literals, so `JSON.stringify()` of the parsed column is not
     * guaranteed to reproduce what a contributor's own `sha256sum layout.json`
     * would produce. Keeping the raw text alongside the parsed column is what
     * makes "byte-for-byte what Pixel Agents exported" true rather than
     * aspirational.
     */
    raw: text('raw').notNull(),
    /** Parsed, for queries and future server-side validation (#8). Not what /download serves. */
    layout: jsonb('layout').notNull(),
    /** sha256 of `raw`. Public, so a third party can dedupe without re-downloading (#6). */
    sha256: text('sha256').notNull(),

    // ── Denormalised from layoutStats(). See the file header. ──
    cols: integer('cols').notNull(),
    rows: integer('rows').notNull(),
    /**
     * The occupied-footprint width/height — see `LayoutStats.visibleCols`.
     * `cols`/`rows` above is the declared canvas allocation and stays that;
     * these are what "size" means to a viewer, and what display, the
     * `largest` sort and the `size` filter actually use (#55).
     */
    visibleCols: integer('visible_cols').notNull().default(0),
    visibleRows: integer('visible_rows').notNull().default(0),
    furnitureCount: integer('furniture_count').notNull().default(0),
    areaCount: integer('area_count').notNull().default(0),
    petCount: integer('pet_count').notNull().default(0),
    carpetCount: integer('carpet_count').notNull().default(0),
    /** How many agents this layout can seat — see LayoutStats.seats. */
    seatCount: integer('seat_count').notNull().default(0),
    layoutRevision: integer('layout_revision').notNull().default(0),

    /** Which upstream it validated against, so #6 can warn a stale consumer. */
    pixelAgentsVersion: text('pixel_agents_version'),

    visibility: layoutVisibility('visibility').notNull().default('public'),
    /**
     * Why it is not public, surfaced to the owner via /me/layouts (#9). A user
     * whose layout disappeared deserves to know. The authoritative record is
     * still moderation_actions; this is the denormalised current reason.
     */
    visibilityReason: text('visibility_reason'),
    visibilityChangedAt: timestamp('visibility_changed_at', { withTimezone: true }),
    visibilityChangedBy: uuid('visibility_changed_by').references(() => users.id, {
      onDelete: 'set null',
    }),

    /** Generated, so it can never drift from the columns it indexes. */
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))`,
    ),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('layouts_slug_key').on(table.slug),
    // Mirrors SLUG_RE in @pixel-index/layout-core. Enforced here too because a
    // bad slug is a permanent, linkable artifact.
    check('layouts_slug_format', sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]*$'`),
    check('layouts_sha256_format', sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check('layouts_grid_positive', sql`${table.cols} > 0 AND ${table.rows} > 0`),

    // Every public read path filters on visibility first, so the indexes that
    // matter for #6 and #14 are partial. A partial index also stays small as
    // hidden and deleted rows accumulate.
    //
    // The "…_idx" sort indexes below all end in `id` as a tiebreaker. #6 uses
    // keyset (cursor) pagination — WHERE (sortCol, id) < (cursorVal, cursorId)
    // — rather than OFFSET, because OFFSET silently skips or repeats rows
    // under concurrent inserts; a stable cursor needs a total order, and
    // `sortCol` alone is not one (two layouts can share a createdAt or a
    // furniture count). Appending `id` makes each of these a fully covered
    // scan for its sort instead of a sort-then-filter.
    index('layouts_public_created_idx')
      .on(table.createdAt.desc(), table.id.desc())
      .where(sql`visibility = 'public'`),
    index('layouts_public_furniture_idx')
      .on(table.furnitureCount.desc(), table.id.desc())
      .where(sql`visibility = 'public'`),
    index('layouts_public_title_idx')
      .on(table.title, table.id)
      .where(sql`visibility = 'public'`),
    index('layouts_public_author_idx')
      .on(table.authorUserId)
      .where(sql`visibility = 'public'`),
    index('layouts_public_search_idx')
      .using('gin', table.searchVector)
      .where(sql`visibility = 'public'`),
    // #14's numeric range filters: size, furniture density, areas, pets.
    index('layouts_public_stats_idx')
      .on(table.furnitureCount, table.areaCount, table.petCount)
      .where(sql`visibility = 'public'`),
    index('layouts_public_size_idx')
      .on(table.cols, table.rows)
      .where(sql`visibility = 'public'`),

    // Owner dashboards (#9) list hidden rows too, so this one is not partial.
    index('layouts_author_idx').on(table.authorUserId),
    // Submission dedupe (#8) checks this before rendering anything.
    index('layouts_sha256_idx').on(table.sha256),
  ],
);

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('tags_name_key').on(table.name),
    // Same vocabulary rule as meta.schema.json's tag pattern.
    check('tags_name_format', sql`${table.name} ~ '^[a-z0-9][a-z0-9-]*$'`),
  ],
);

/** Join table, so filtering by tag is an index scan rather than a JSON scan. */
export const layoutTags = pgTable(
  'layout_tags',
  {
    layoutId: uuid('layout_id')
      .notNull()
      .references(() => layouts.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.layoutId, table.tagId] }),
    // The reverse direction: "every layout with this tag".
    index('layout_tags_tag_idx').on(table.tagId, table.layoutId),
  ],
);

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    layoutId: uuid('layout_id')
      .notNull()
      .references(() => layouts.id, { onDelete: 'cascade' }),

    /**
     * Null for anonymous reports. #10 decides whether to accept them; the schema
     * supports both so that decision does not need a migration.
     */
    reporterUserId: uuid('reporter_user_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * Lets anonymous reporting be rate-limited without storing an IP address.
     * Hash with a server-side secret, never a bare IP.
     */
    reporterIpHash: text('reporter_ip_hash'),

    reason: reportReason('reason').notNull(),
    detail: text('detail'),

    status: reportStatus('status').notNull().default('open'),
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionNote: text('resolution_note'),

    createdAt: createdAt(),
  },
  (table) => [
    // The moderator queue: open reports, oldest first.
    index('reports_open_idx')
      .on(table.createdAt)
      .where(sql`status = 'open'`),
    index('reports_layout_idx').on(table.layoutId, table.createdAt.desc()),
    check(
      'reports_resolution_consistent',
      sql`(${table.status} = 'open') = (${table.resolvedAt} IS NULL)`,
    ),
  ],
);

/**
 * Append-only audit log. Enforced by a trigger in migration 0001, not by
 * convention — see the file header.
 *
 * **Neither `targetId` nor `actorUserId` is a foreign key**, and that is
 * deliberate: history has to outlive whatever it describes. A removal that
 * erased its own evidence would defeat the purpose, and — less obviously — an
 * `ON DELETE SET NULL` reference is itself an UPDATE, which the append-only
 * trigger rejects. With a real FK, deleting any user who had ever moderated
 * anything would fail outright.
 *
 * The cost is no referential integrity on either column; `actorLabel` and the
 * `before`/`after` snapshots are what keep a row legible after its subjects are
 * gone. Reconstructing a layout's history means selecting on
 * (targetType='layout', targetId) ordered by createdAt.
 */
export const moderationActions = pgTable(
  'moderation_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Null for actions taken by migrations or the seeder. No FK — see above. */
    actorUserId: uuid('actor_user_id'),
    /** Who it was, in words, so the row survives the account being deleted. */
    actorLabel: text('actor_label'),

    action: auditAction('action').notNull(),
    targetType: auditTargetType('target_type').notNull(),
    targetId: uuid('target_id').notNull(),

    /** Required for every moderator action; #10 rejects a hide without one. */
    reason: text('reason'),
    before: jsonb('before'),
    after: jsonb('after'),

    createdAt: createdAt(),
  },
  (table) => [
    index('moderation_actions_target_idx').on(
      table.targetType,
      table.targetId,
      table.createdAt,
    ),
    index('moderation_actions_actor_idx').on(table.actorUserId, table.createdAt.desc()),
  ],
);

/**
 * Refresh tokens for the bearer-token session (#7, ADR 0001 decision 10).
 *
 * Never stores a usable token — only `tokenHash`, sha256 of the raw value the
 * client holds, so a database dump alone cannot be replayed as a session.
 *
 * `familyId` links every token descended from one login through rotation.
 * Refreshing sets `rotatedToId` on the token just spent and issues a new row
 * in the same family. A refresh request presenting a token that already has
 * `rotatedToId` set is a stolen-and-reused token: the app revokes the whole
 * family, not just that one row, because at that point neither the attacker's
 * nor the legitimate holder's copy can be trusted to be the "real" one.
 *
 * `rotatedToId` is deliberately not a foreign key — Drizzle self-references
 * add real friction for a link that is never queried by join, only compared
 * for presence, and the security property it encodes (detecting reuse) does
 * not depend on referential integrity.
 */
export const authRefreshTokens = pgTable(
  'auth_refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    familyId: uuid('family_id').notNull(),
    rotatedToId: uuid('rotated_to_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('auth_refresh_tokens_token_hash_key').on(table.tokenHash),
    index('auth_refresh_tokens_family_idx').on(table.familyId),
    index('auth_refresh_tokens_user_idx').on(table.userId),
    check('auth_refresh_tokens_hash_format', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * A user's retained Discord OAuth grant. Tokens are AES-256-GCM ciphertext;
 * the key is supplied only to the API process and never stored in Postgres.
 */
export const discordOauthGrants = pgTable('discord_oauth_grants', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  encryptedAccessToken: text('encrypted_access_token').notNull(),
  encryptedRefreshToken: text('encrypted_refresh_token').notNull(),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }).notNull(),
  scopes: text('scopes').notNull(),
  updatedAt: updatedAt(),
});

/**
 * The one-time code used to hand a freshly-minted session to the SPA.
 *
 * `/callback` is a full top-level navigation landing on the API's own origin —
 * there is no SPA JavaScript running there to receive tokens directly, and
 * putting the real access/refresh tokens in a 302's query string would leak
 * them into browser history and any access log between here and the frontend.
 * Instead the callback redirects to the frontend with a single-use code; the
 * SPA immediately exchanges it over a normal CORS `fetch`, which is where the
 * tokens actually appear in a response body for the first time.
 *
 * 60 seconds is generous for "the browser finishes one more redirect and the
 * SPA's landing script runs" and stingy for anything else.
 */
export const authLoginCodes = pgTable(
  'auth_login_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    codeHash: text('code_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('auth_login_codes_code_hash_key').on(table.codeHash),
    check('auth_login_codes_hash_format', sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * A moderator-created receiver for versioned Pixel Index webhook events.
 *
 * The usable secret is encrypted with the deployment's API-only webhook key.
 * `secretHint` is the only part ever returned after creation/rotation. Creator
 * identity is snapshotted as Discord-backed data so the Admin view remains
 * useful even if the cached user profile later changes.
 */
export const webhookSubscriptions = pgTable(
  'webhook_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    endpointUrl: text('endpoint_url').notNull(),
    encryptedSecret: text('encrypted_secret').notNull(),
    secretHint: text('secret_hint').notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdByDiscordId: text('created_by_discord_id').notNull(),
    createdByUsername: text('created_by_username').notNull(),
    active: boolean('active').notNull().default(true),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    lastFailure: text('last_failure'),
    secretRotatedAt: timestamp('secret_rotated_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('webhook_subscriptions_name_key').on(table.name),
    index('webhook_subscriptions_creator_idx').on(table.createdByUserId, table.createdAt.desc()),
    index('webhook_subscriptions_active_idx')
      .on(table.createdAt)
      .where(sql`active = true`),
    check('webhook_subscriptions_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check('webhook_subscriptions_secret_hint_length', sql`length(${table.secretHint}) = 4`),
    check('webhook_subscriptions_failures_nonnegative', sql`${table.consecutiveFailures} >= 0`),
  ],
);

/** One accepted Share action. `data` is the immutable event-time snapshot. */
export const shareEvents = pgTable(
  'share_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sharerUserId: uuid('sharer_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    data: jsonb('data').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('share_events_sharer_occurred_idx').on(table.sharerUserId, table.occurredAt.desc())],
);

/**
 * One event/subscription pair in the persistent delivery queue. A short lease
 * prevents two API replicas from posting the same attempt concurrently; event
 * and subscription ids still make receiver-side deduplication authoritative.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => shareEvents.id, { onDelete: 'cascade' }),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: 'restrict' }),
    status: webhookDeliveryStatus('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lockToken: uuid('lock_token'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('webhook_deliveries_event_subscription_key').on(table.eventId, table.subscriptionId),
    index('webhook_deliveries_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`status IN ('pending', 'retrying')`),
    index('webhook_deliveries_subscription_idx').on(table.subscriptionId, table.createdAt.desc()),
    check('webhook_deliveries_attempts_nonnegative', sql`${table.attemptCount} >= 0`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Layout = typeof layouts.$inferSelect;
export type NewLayout = typeof layouts.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;
export type ModerationAction = typeof moderationActions.$inferSelect;
export type NewModerationAction = typeof moderationActions.$inferInsert;
export type AuthRefreshToken = typeof authRefreshTokens.$inferSelect;
export type NewAuthRefreshToken = typeof authRefreshTokens.$inferInsert;
export type DiscordOauthGrant = typeof discordOauthGrants.$inferSelect;
export type NewDiscordOauthGrant = typeof discordOauthGrants.$inferInsert;
export type AuthLoginCode = typeof authLoginCodes.$inferSelect;
export type NewAuthLoginCode = typeof authLoginCodes.$inferInsert;
export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;
export type NewWebhookSubscription = typeof webhookSubscriptions.$inferInsert;
export type ShareEvent = typeof shareEvents.$inferSelect;
export type NewShareEvent = typeof shareEvents.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
