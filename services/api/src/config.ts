/**
 * Configuration, from the environment only.
 *
 * No hostname, domain or deployment-specific string is compiled in — a
 * self-hoster sets `DATABASE_URL`, `RENDERER_URL`, `PUBLIC_WEB_ORIGIN` and the
 * Discord credentials, and nothing else. See ADR 0001, decision 8.
 *
 * Every required variable is validated at boot and reported together, so a
 * misconfigured deployment fails once with a full list rather than one
 * frustrating restart per missing value.
 */

export interface RateLimitBucket {
  max: number;
  windowMs: number;
}

/** A compiled `PUBLIC_WEB_ORIGIN_PATTERNS` entry. `source` is kept for logs and errors. */
export interface OriginPattern {
  source: string;
  matcher: RegExp;
}

export interface ApiConfig {
  host: string;
  port: number;
  logLevel: string;
  /** Refuse an oversized body at the socket, before it is parsed. */
  bodyLimitBytes: number;
  /**
   * Trust `X-Forwarded-For` from the reverse proxy. Required for rate limiting
   * to key on the real client, not the proxy — every deployment in the
   * architecture sits behind one (Traefik, Cloudflare Tunnel), so this defaults
   * to true. A self-hoster exposing the API directly, with no proxy in front,
   * must set it to false or every client shares one rate-limit bucket.
   */
  trustProxy: boolean;

  databaseUrl: string;
  /** The renderer service (#4), proxied by GET /layouts/:slug/{preview,thumbnail}.png (#6). */
  rendererUrl: string;
  /**
   * Exact origins allowed to call the API with credentials. No wildcards.
   *
   * A non-empty tuple, because `loadConfig` refuses to boot without at least
   * one and `resolveReturnTo` (auth/routes.ts) needs the first one to be a
   * `string` rather than `string | undefined`. It used to be a plain array, and
   * `${config.webOrigins[0]}/` therefore built the relative path `"undefined/"`
   * if the list were ever empty — on the OAuth callback's error path, where
   * that string is handed straight to `reply.redirect()`.
   */
  webOrigins: [string, ...string[]];
  /**
   * Opt-in, narrowly scoped patterns for origins that cannot be listed
   * exactly because the platform mints a fresh hostname per deploy — a
   * Vercel PR preview is `<project>-<build-hash>-<team>.vercel.app` (#28).
   * Empty unless `PUBLIC_WEB_ORIGIN_PATTERNS` is set; see
   * `parseOriginPattern` for what a pattern is allowed to look like and
   * `allowsWebOrigin` for how one is matched.
   */
  webOriginPatterns: OriginPattern[];

  /**
   * Where the pinned upstream lives, for `GET /api/v1/meta`'s `pixelAgents`
   * field (layout-core's `upstreamPin()`). Optional: auto-discovered by
   * walking up from this package in a normal checkout; a container needs it
   * explicit because the copied `vendor/pixel-agents` sits at a fixed path
   * with no ancestor relationship to worry about.
   */
  upstreamDir?: string;

  discordClientId: string;
  discordClientSecret: string;
  /** Discord user ids which receive the Admin capability after membership is verified. */
  discordAdminIds: string[];
  /**
   * Optional community integration. An instance without this keeps ordinary
   * Discord login and accepts submissions from every authenticated user.
   */
  discordGuild?: {
    id: string;
    inviteUrl: string;
    moderatorRoleIds: string[];
    /** Base64-encoded 32-byte AES-256-GCM key; consumed only by the API. */
    oauthTokenEncryptionKey: string;
  };
  /** Maximum age of a successful Discord membership/capability observation. */
  discordMembershipCacheTtlMs: number;
  /**
   * This API's own externally-reachable origin. The OAuth `redirect_uri` sent
   * to Discord is always `${publicApiOrigin}/callback` — never derived from
   * request input — which is what "the redirect URI is allowlisted" means in
   * practice for a value Discord itself also strictly matches against what is
   * registered in the Developer Portal. Both sides have to agree on this
   * value; see auth/discord.ts and the ADR.
   */
  publicApiOrigin: string;
  /**
   * This checkout's own `git rev-parse HEAD`, for `GET /` and `GET
   * /api/v1/meta` — a different thing from `upstreamDir`'s pinned Pixel
   * Agents commit above. Unlike that pin, this repository's own `.git` is
   * ordinarily reachable wherever `docker build` runs, so this travels as a
   * plain build ARG (see `services/api/Dockerfile`'s `API_COMMIT`) rather
   * than a committed stamp file. `undefined` — reported as `commit: null` —
   * whenever nobody passed one, e.g. a local `npm run dev` with no Docker
   * involved at all; this is informational only, so that is not an error.
   */
  commit?: string;
  /** Signs access tokens (HS256) and the transient OAuth state cookie. */
  sessionSecret: string;
  /** Base64-encoded 32-byte AES-256-GCM key for subscriber signing secrets at rest. */
  webhookSecretEncryptionKey: string;
  /** How long a minted access token is valid without a fresh DB lookup. */
  accessTokenTtlMs: number;
  /** How long an unused refresh token stays valid. */
  refreshTokenTtlMs: number;
  /** How long the post-login handoff code to the SPA stays valid. */
  loginCodeTtlMs: number;

  /**
   * Refused before JSON.parse even runs (#8). Matches the renderer's own
   * default (`RENDERER_MAX_LAYOUT_BYTES`) so a layout that clears this check
   * is never subsequently rejected by the renderer for being oversized —
   * independently configurable because the two services are configured
   * independently and there is no reason to force them to agree.
   */
  maxLayoutBytes: number;
  /**
   * Post-moderation means nothing stands between a stranger and the front
   * page except this and the rate-limit bucket below — a flood is a real,
   * cheap attack (#8). Checked against a real count of the user's last 24h
   * of submissions, not a token-bucket approximation.
   */
  maxSubmissionsPerUserPerDay: number;
  /** Persistent rolling-24-hour cap; the short Share bucket below is independent. */
  maxSharesPerUserPerDay: number;

  rateLimit: RateLimitBucket;
  /** Tighter bucket for #8's submission and #4's render-triggering paths. */
  writeRateLimit: RateLimitBucket;
  /** Authenticated, per-user Share bucket (one accepted request per five minutes by default). */
  shareRateLimit: RateLimitBucket;
  /**
   * Its own bucket for the bulk export (#26), because it is the one read
   * path whose cost per request scales with the size of the index rather than
   * being constant. A caller that wants the whole index should take it in
   * one streamed request — which is cheap — instead of the several hundred
   * per-slug requests the general bucket would happily allow.
   */
  exportRateLimit: RateLimitBucket;
  /**
   * The one route whose body is deliberately allowed to exceed
   * `bodyLimitBytes` (#63): `POST /api/v1/admin/backup/import` accepts a zip
   * of potentially hundreds of layouts, not one. Enforced as that route's own
   * `bodyLimit` override rather than raising the global limit — every other
   * route stays bounded by the smaller default.
   */
  maxImportBytes: number;
  /**
   * A static, non-rotating shared secret for `GET /api/v1/admin/backup`
   * (#63), checked against the `X-Backup-Api-Key` header — independently of,
   * and before, the usual Discord-session admin check. Unset by default: a
   * self-hoster who doesn't run the scheduled backup workflow sets nothing,
   * and the route falls back to the ordinary human admin session.
   *
   * Deliberately NOT a database-backed credential (no rotation, no reuse
   * detection, no revocation table) — same shape as `sessionSecret`/
   * `discordClientSecret` below: a value the deployment operator generates
   * once, sets on both this process and the GitHub Actions secret, and
   * rotates by generating a new one and redeploying both sides. Scoped to
   * this one read-only route only: `POST /api/v1/admin/backup/import` never
   * reads it, so a leaked key can read a backup but never write anything.
   */
  backupApiKey?: string;
}

export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

function intFromEnv(name: string, fallback: number, problems: string[]): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    problems.push(`${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  return Math.floor(value);
}

function boolFromEnv(name: string, fallback: boolean, problems: string[]): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  problems.push(`${name} must be "true" or "false", got ${JSON.stringify(raw)}`);
  return fallback;
}

function requireEnv(name: string, problems: string[]): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    problems.push(`${name} is required`);
    return '';
  }
  return raw;
}

/** @param schemes Accepted URL schemes, without the trailing colon. */
function requireUrl(name: string, problems: string[], schemes: string[]): string {
  const raw = requireEnv(name, problems);
  if (raw === '') return raw;
  try {
    const url = new URL(raw);
    const scheme = url.protocol.replace(/:$/, '');
    if (!schemes.includes(scheme)) {
      problems.push(
        `${name} must use one of [${schemes.join(', ')}], got ${JSON.stringify(raw)}`,
      );
    }
  } catch {
    problems.push(`${name} must be a valid URL, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * A comma-separated list of exact origins — scheme + host + optional port,
 * nothing else. `new URL(origin).origin === origin` is what rules out a path,
 * query string or trailing slash sneaking in and silently never matching a
 * real browser Origin header.
 */
function requireOriginList(name: string, problems: string[]): [string, ...string[]] {
  const raw = requireEnv(name, problems);
  if (raw === '') return [PLACEHOLDER_ORIGIN];

  const origins = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (origins.length === 0) {
    problems.push(`${name} must contain at least one origin`);
    return [PLACEHOLDER_ORIGIN];
  }

  const valid: string[] = [];
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (url.origin !== origin) {
        problems.push(
          `${name} entry ${JSON.stringify(origin)} must be an origin only (no path, query or trailing slash)`,
        );
        continue;
      }
      valid.push(url.origin);
    } catch {
      problems.push(`${name} entry ${JSON.stringify(origin)} is not a valid origin`);
    }
  }

  const [primary, ...rest] = valid;
  if (primary === undefined) return [PLACEHOLDER_ORIGIN];
  return [primary, ...rest];
}

/**
 * What `requireOriginList` returns once it has recorded a problem — the same
 * convention `requireEnv` uses when it returns `''`. `loadConfig` throws on any
 * recorded problem before the config object escapes, so this value is
 * unreachable by design; having one is what lets `webOrigins` be a non-empty
 * tuple instead of an array whose first element is `string | undefined`.
 */
const PLACEHOLDER_ORIGIN = '';

/**
 * The site's own home page: where login sends a browser back when the caller
 * asked for nowhere, or asked for somewhere not allowed.
 *
 * Named because both auth routes need it and one of them feeds it to
 * `reply.redirect()` — a duplicated `${config.webOrigins[0]}/` is how the two
 * copies drift.
 */
export function webHomeUrl(config: Pick<ApiConfig, 'webOrigins'>): string {
  return `${config.webOrigins[0]}/`;
}

/**
 * Stands in for the `*` while a pattern is checked with `new URL()`. Any
 * ordinary hostname label works; this one is deliberately unlikely to collide
 * with a literal the operator actually wrote.
 */
const WILDCARD_PROBE = 'wildcardprobe';

/** What `*` is allowed to expand to: one hostname label's worth of characters, never a dot. */
const WILDCARD_EXPANSION = '[a-z0-9-]+';

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles one `PUBLIC_WEB_ORIGIN_PATTERNS` entry.
 *
 * This exists because a Vercel PR preview gets a fresh hostname on every
 * single deploy (`<project>-<build-hash>-<team>.vercel.app`), so there is no
 * exact origin to put in `PUBLIC_WEB_ORIGIN` — and without one, every
 * credentialed call from a preview fails CORS (#28). It is deliberately
 * *opt-in* and deliberately narrow, because anything matched here can make
 * credentialed cross-origin requests:
 *
 *   - https only. A wildcard over cleartext is not defensible, and every
 *     platform that mints per-deploy hostnames serves them over TLS anyway.
 *   - Exactly one `*`, and it only ever expands within a single hostname
 *     label — never across a dot, so `https://pixel-index-*.example.com`
 *     can never match `https://evil.attacker.example.com`.
 *   - The wildcard label must carry at least one literal character. That is
 *     what rules out `https://*.vercel.app`, which would hand credentialed
 *     access to every project on a shared platform domain rather than yours.
 *
 * The residual risk is real and worth stating plainly: anyone who can deploy
 * a hostname matching your pattern on that shared domain gets the same
 * access. Pin as much literal text as your platform allows — on Vercel that
 * means including your team slug, which is not something a stranger can mint
 * (`https://pixel-index-*-your-team.vercel.app`).
 */
function parseOriginPattern(name: string, pattern: string, problems: string[]): OriginPattern | null {
  const wildcards = pattern.split('*').length - 1;
  if (wildcards !== 1) {
    problems.push(
      `${name} entry ${JSON.stringify(pattern)} must contain exactly one "*" (got ${wildcards})`,
    );
    return null;
  }

  // Substituting a real label first means one `new URL()` catches every way a
  // pattern can be malformed — bad scheme, a path, a query, a trailing slash.
  const probe = pattern.replace('*', WILDCARD_PROBE);
  let url: URL;
  try {
    url = new URL(probe);
  } catch {
    problems.push(`${name} entry ${JSON.stringify(pattern)} is not a valid origin`);
    return null;
  }
  if (url.origin !== probe) {
    problems.push(
      `${name} entry ${JSON.stringify(pattern)} must be an origin only (no path, query or trailing slash)`,
    );
    return null;
  }
  if (url.protocol !== 'https:') {
    problems.push(`${name} entry ${JSON.stringify(pattern)} must use https`);
    return null;
  }

  const wildcardLabel = url.hostname.split('.').find((label) => label.includes(WILDCARD_PROBE));
  if (wildcardLabel === undefined) {
    // The `*` landed somewhere that is not a hostname label at all — a port,
    // say — where it cannot be matched safely.
    problems.push(
      `${name} entry ${JSON.stringify(pattern)} must place "*" inside a hostname label`,
    );
    return null;
  }
  if (wildcardLabel === WILDCARD_PROBE) {
    problems.push(
      `${name} entry ${JSON.stringify(pattern)} is too broad: "*" must not be a whole hostname ` +
        'label. Pin literal text around it (e.g. "https://my-app-*-my-team.vercel.app") — a ' +
        'whole-label wildcard grants credentialed access to every deployment on a shared domain.',
    );
    return null;
  }

  // `url.origin`, not the raw pattern — the two are identical by the check
  // above, and using the parsed one makes it explicit that the matcher is
  // built from the same normalized form a browser's `Origin` header takes.
  const [before, after] = url.origin.split(WILDCARD_PROBE) as [string, string];
  const matcher = new RegExp(`^${escapeRegExp(before)}${WILDCARD_EXPANSION}${escapeRegExp(after)}$`);
  return { source: pattern, matcher };
}

/** Optional counterpart to `requireOriginList` — absent means "no patterns", not an error. */
function optionalOriginPatterns(name: string, problems: string[]): OriginPattern[] {
  const raw = optionalEnv(name);
  if (raw === undefined) return [];

  const patterns: OriginPattern[] = [];
  for (const entry of raw.split(',').map((part) => part.trim()).filter((part) => part.length > 0)) {
    const parsed = parseOriginPattern(name, entry, problems);
    if (parsed) patterns.push(parsed);
  }
  return patterns;
}

/**
 * The one place that answers "may this browser origin call us with
 * credentials?" — CORS (server.ts) and the OAuth `returnTo` allowlist
 * (auth/routes.ts) have to agree, or logging in from a preview deploy
 * succeeds at the redirect and then fails at the first API call.
 */
export function allowsWebOrigin(
  config: Pick<ApiConfig, 'webOrigins' | 'webOriginPatterns'>,
  origin: string,
): boolean {
  if (config.webOrigins.includes(origin)) return true;
  return config.webOriginPatterns.some((pattern) => pattern.matcher.test(origin));
}

/** The single-value form of `requireOriginList` — exactly one origin, nothing else. */
function requireOrigin(name: string, problems: string[]): string {
  const raw = requireEnv(name, problems);
  if (raw === '') return raw;
  try {
    const url = new URL(raw);
    if (url.origin !== raw) {
      problems.push(
        `${name} must be an origin only (no path, query or trailing slash), got ${JSON.stringify(raw)}`,
      );
      return url.origin;
    }
    return url.origin;
  } catch {
    problems.push(`${name} is not a valid origin, got ${JSON.stringify(raw)}`);
    return raw;
  }
}

const MIN_SESSION_SECRET_LENGTH = 32;

function requireSessionSecret(problems: string[]): string {
  const raw = requireEnv('SESSION_SECRET', problems);
  if (raw !== '' && raw.length < MIN_SESSION_SECRET_LENGTH) {
    problems.push(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters ` +
        `(got ${raw.length}) — short signing keys are brute-forceable. ` +
        'Generate one with: openssl rand -base64 48',
    );
  }
  return raw;
}

function optionalEnv(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw;
}

const MIN_BACKUP_API_KEY_LENGTH = 32;

/** Optional, unlike `requireSessionSecret` above — but held to the same length bar when set. */
function backupApiKey(problems: string[]): string | undefined {
  const raw = optionalEnv('BACKUP_API_KEY');
  if (raw === undefined) return undefined;
  if (raw.length < MIN_BACKUP_API_KEY_LENGTH) {
    problems.push(
      `BACKUP_API_KEY must be at least ${MIN_BACKUP_API_KEY_LENGTH} characters ` +
        `(got ${raw.length}) — short shared secrets are brute-forceable. ` +
        'Generate one with: openssl rand -base64 32',
    );
  }
  return raw;
}

const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

function discordIdsFromEnv(name: string, problems: string[]): string[] {
  const raw = optionalEnv(name);
  if (!raw) return [];
  const ids = raw.split(',').map((value) => value.trim()).filter(Boolean);
  for (const id of ids) {
    if (!DISCORD_SNOWFLAKE_RE.test(id)) {
      problems.push(`${name} must contain comma-separated Discord snowflakes, got ${JSON.stringify(id)}`);
    }
  }
  if (new Set(ids).size !== ids.length) problems.push(`${name} must not contain duplicate ids`);
  return ids;
}

function discordInviteUrl(problems: string[]): string | undefined {
  const raw = optionalEnv('DISCORD_INVITE_URL');
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') problems.push('DISCORD_INVITE_URL must use https');
    return url.toString();
  } catch {
    problems.push(`DISCORD_INVITE_URL is not a valid URL, got ${JSON.stringify(raw)}`);
    return raw;
  }
}

function discordEncryptionKey(problems: string[]): string | undefined {
  const raw = optionalEnv('DISCORD_OAUTH_TOKEN_ENCRYPTION_KEY');
  if (!raw) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || Buffer.from(raw, 'base64').length !== 32) {
    problems.push(
      'DISCORD_OAUTH_TOKEN_ENCRYPTION_KEY must be base64 encoding of exactly 32 bytes ' +
        '(generate with: openssl rand -base64 32)',
    );
  }
  return raw;
}

function webhookEncryptionKey(problems: string[]): string {
  const raw = requireEnv('WEBHOOK_SECRET_ENCRYPTION_KEY', problems);
  if (
    raw !== '' &&
    (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || Buffer.from(raw, 'base64').length !== 32)
  ) {
    problems.push(
      'WEBHOOK_SECRET_ENCRYPTION_KEY must be base64 encoding of exactly 32 bytes ' +
        '(generate with: openssl rand -base64 32)',
    );
  }
  return raw;
}

export function loadConfig(): ApiConfig {
  const problems: string[] = [];
  const discordGuildId = optionalEnv('DISCORD_GUILD_ID');
  const discordAdminIds = discordIdsFromEnv('DISCORD_ADMIN_IDS', problems);
  const discordModeratorRoleIds = discordIdsFromEnv('DISCORD_MODERATOR_ROLE_IDS', problems);
  const inviteUrl = discordInviteUrl(problems);
  const oauthTokenEncryptionKey = discordEncryptionKey(problems);
  const upstreamDir = optionalEnv('PIXEL_AGENTS_DIR');
  const commit = optionalEnv('API_COMMIT');
  const backupKey = backupApiKey(problems);
  const webhookSecretEncryptionKey = webhookEncryptionKey(problems);

  if (discordGuildId && !DISCORD_SNOWFLAKE_RE.test(discordGuildId)) {
    problems.push(`DISCORD_GUILD_ID must be a Discord snowflake, got ${JSON.stringify(discordGuildId)}`);
  }
  if (discordGuildId) {
    if (!inviteUrl) problems.push('DISCORD_INVITE_URL is required when DISCORD_GUILD_ID is set');
    if (!oauthTokenEncryptionKey) {
      problems.push('DISCORD_OAUTH_TOKEN_ENCRYPTION_KEY is required when DISCORD_GUILD_ID is set');
    }
  } else {
    if (discordModeratorRoleIds.length > 0) {
      problems.push('DISCORD_MODERATOR_ROLE_IDS requires DISCORD_GUILD_ID');
    }
    if (inviteUrl) problems.push('DISCORD_INVITE_URL requires DISCORD_GUILD_ID');
    if (oauthTokenEncryptionKey) {
      problems.push('DISCORD_OAUTH_TOKEN_ENCRYPTION_KEY requires DISCORD_GUILD_ID');
    }
  }
  if (optionalEnv('INITIAL_ADMIN_DISCORD_ID')) {
    problems.push('INITIAL_ADMIN_DISCORD_ID is no longer supported; use DISCORD_ADMIN_IDS');
  }

  const config: ApiConfig = {
    host: process.env.API_HOST ?? '::',
    port: intFromEnv('API_PORT', 3000, problems),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    bodyLimitBytes: intFromEnv('API_BODY_LIMIT_BYTES', 5_000_000, problems),
    trustProxy: boolFromEnv('API_TRUST_PROXY', true, problems),

    databaseUrl: requireUrl('DATABASE_URL', problems, ['postgres', 'postgresql']),
    rendererUrl: requireUrl('RENDERER_URL', problems, ['http', 'https']),
    webOrigins: requireOriginList('PUBLIC_WEB_ORIGIN', problems),
    webOriginPatterns: optionalOriginPatterns('PUBLIC_WEB_ORIGIN_PATTERNS', problems),

    ...(upstreamDir ? { upstreamDir } : {}),

    discordClientId: requireEnv('DISCORD_CLIENT_ID', problems),
    discordClientSecret: requireEnv('DISCORD_CLIENT_SECRET', problems),
    discordAdminIds,
    ...(discordGuildId && inviteUrl && oauthTokenEncryptionKey
      ? {
          discordGuild: {
            id: discordGuildId,
            inviteUrl,
            moderatorRoleIds: discordModeratorRoleIds,
            oauthTokenEncryptionKey,
          },
        }
      : {}),
    discordMembershipCacheTtlMs: intFromEnv(
      'DISCORD_MEMBERSHIP_CACHE_TTL_MS',
      60_000,
      problems,
    ),
    ...(commit ? { commit } : {}),
    publicApiOrigin: requireOrigin('PUBLIC_API_ORIGIN', problems),
    sessionSecret: requireSessionSecret(problems),
    webhookSecretEncryptionKey,
    accessTokenTtlMs: intFromEnv('ACCESS_TOKEN_TTL_MS', 15 * 60_000, problems),
    refreshTokenTtlMs: intFromEnv('REFRESH_TOKEN_TTL_MS', 30 * 24 * 60 * 60_000, problems),
    loginCodeTtlMs: intFromEnv('LOGIN_CODE_TTL_MS', 60_000, problems),

    maxLayoutBytes: intFromEnv('MAX_LAYOUT_BYTES', 2_000_000, problems),
    maxSubmissionsPerUserPerDay: intFromEnv('MAX_SUBMISSIONS_PER_USER_PER_DAY', 20, problems),
    maxSharesPerUserPerDay: intFromEnv('MAX_SHARES_PER_USER_PER_DAY', 5, problems),

    rateLimit: {
      max: intFromEnv('RATE_LIMIT_MAX', 300, problems),
      windowMs: intFromEnv('RATE_LIMIT_WINDOW_MS', 60_000, problems),
    },
    writeRateLimit: {
      max: intFromEnv('RATE_LIMIT_WRITE_MAX', 20, problems),
      windowMs: intFromEnv('RATE_LIMIT_WRITE_WINDOW_MS', 60_000, problems),
    },
    shareRateLimit: {
      max: intFromEnv('RATE_LIMIT_SHARE_MAX', 1, problems),
      windowMs: intFromEnv('RATE_LIMIT_SHARE_WINDOW_MS', 5 * 60_000, problems),
    },
    exportRateLimit: {
      max: intFromEnv('RATE_LIMIT_EXPORT_MAX', 6, problems),
      windowMs: intFromEnv('RATE_LIMIT_EXPORT_WINDOW_MS', 60_000, problems),
    },
    // 50 MB comfortably fits a full backup zip at today's scale (a few
    // thousand layouts well under `maxLayoutBytes` each, plus small meta.json
    // entries and DEFLATE compression) while still bounding a malicious
    // upload's worst case — unlike `bodyLimitBytes`, this is refused before
    // JSON.parse or zip decoding ever runs.
    maxImportBytes: intFromEnv('MAX_IMPORT_BYTES', 50_000_000, problems),
    ...(backupKey ? { backupApiKey: backupKey } : {}),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
