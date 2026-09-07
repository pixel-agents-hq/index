import { afterEach, describe, expect, it } from 'vitest';

import { allowsWebOrigin, ConfigError, loadConfig } from './config.js';

const REQUIRED = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/pixel_index',
  RENDERER_URL: 'http://renderer.internal:3000',
  PUBLIC_WEB_ORIGIN: 'https://pixel-index.example',
  DISCORD_CLIENT_ID: 'client-id',
  DISCORD_CLIENT_SECRET: 'client-secret',
  PUBLIC_API_ORIGIN: 'https://api.pixel-index.example',
  SESSION_SECRET: 'a'.repeat(32),
  WEBHOOK_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'),
} as const;

const ENV_KEYS = [
  ...Object.keys(REQUIRED),
  'API_HOST',
  'API_PORT',
  'LOG_LEVEL',
  'API_BODY_LIMIT_BYTES',
  'API_TRUST_PROXY',
  'RATE_LIMIT_MAX',
  'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_WRITE_MAX',
  'RATE_LIMIT_WRITE_WINDOW_MS',
  'RATE_LIMIT_SHARE_MAX',
  'RATE_LIMIT_SHARE_WINDOW_MS',
  'RATE_LIMIT_EXPORT_MAX',
  'RATE_LIMIT_EXPORT_WINDOW_MS',
  'INITIAL_ADMIN_DISCORD_ID',
  'DISCORD_ADMIN_IDS',
  'DISCORD_GUILD_ID',
  'DISCORD_INVITE_URL',
  'DISCORD_MODERATOR_ROLE_IDS',
  'DISCORD_OAUTH_TOKEN_ENCRYPTION_KEY',
  'DISCORD_MEMBERSHIP_CACHE_TTL_MS',
  'ACCESS_TOKEN_TTL_MS',
  'REFRESH_TOKEN_TTL_MS',
  'LOGIN_CODE_TTL_MS',
  'PIXEL_AGENTS_DIR',
  'API_COMMIT',
  'MAX_LAYOUT_BYTES',
  'MAX_SUBMISSIONS_PER_USER_PER_DAY',
  'MAX_SHARES_PER_USER_PER_DAY',
  'MAX_IMPORT_BYTES',
  'BACKUP_API_KEY',
  'PUBLIC_WEB_ORIGIN_PATTERNS',
] as const;

function setRequired(overrides: Partial<Record<string, string>> = {}) {
  for (const [key, value] of Object.entries(REQUIRED)) process.env[key] = value;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}

afterEach(() => {
  // Reflect.deleteProperty rather than `delete`: unsetting a variable is the
  // only correct behaviour here (assigning undefined gives the literal string
  // "undefined", which is the bug these tests exist to catch), and this is the
  // spelling that says so without tripping no-dynamic-delete. Same idiom as
  // apps/web's LayoutJsonPanel.test.tsx.
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
});

describe('loadConfig — required variables', () => {
  it('boots with every required variable set', () => {
    setRequired();
    const config = loadConfig();
    expect(config.databaseUrl).toBe(REQUIRED.DATABASE_URL);
    expect(config.rendererUrl).toBe(REQUIRED.RENDERER_URL);
    expect(config.webOrigins).toEqual(['https://pixel-index.example']);
    expect(config.discordClientId).toBe('client-id');
    expect(config.discordClientSecret).toBe('client-secret');
  });

  it.each(Object.keys(REQUIRED))('fails loudly when %s is missing', (missing) => {
    setRequired({ [missing]: undefined });
    expect(() => loadConfig()).toThrow(ConfigError);
    try {
      loadConfig();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain(missing);
    }
  });

  it('reports every missing variable in one error, not one restart per variable', () => {
    // Nothing set at all.
    try {
      loadConfig();
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      for (const key of Object.keys(REQUIRED)) expect(message).toContain(key);
    }
  });

  it('rejects an empty string the same as unset', () => {
    setRequired({ DISCORD_CLIENT_ID: '   ' });
    expect(() => loadConfig()).toThrow(/DISCORD_CLIENT_ID is required/);
  });
});

describe('loadConfig — RENDERER_URL and DATABASE_URL', () => {
  it('rejects a non-URL', () => {
    setRequired({ RENDERER_URL: 'not a url' });
    expect(() => loadConfig()).toThrow(/RENDERER_URL must be a valid URL/);
  });

  it('rejects a non-http(s) scheme for RENDERER_URL', () => {
    setRequired({ RENDERER_URL: 'ftp://renderer.internal' });
    expect(() => loadConfig()).toThrow(/RENDERER_URL must use one of \[http, https\]/);
  });

  it('accepts a postgres:// DATABASE_URL — which an http(s)-only check would wrongly reject', () => {
    setRequired({ DATABASE_URL: 'postgresql://user:pass@localhost:5432/pixel_index' });
    expect(loadConfig().databaseUrl).toBe('postgresql://user:pass@localhost:5432/pixel_index');
  });

  it('rejects a non-postgres scheme for DATABASE_URL', () => {
    setRequired({ DATABASE_URL: 'http://not-a-database' });
    expect(() => loadConfig()).toThrow(/DATABASE_URL must use one of \[postgres, postgresql\]/);
  });
});

describe('loadConfig — PUBLIC_WEB_ORIGIN', () => {
  it('accepts multiple comma-separated origins', () => {
    setRequired({ PUBLIC_WEB_ORIGIN: 'https://a.example, https://b.example' });
    expect(loadConfig().webOrigins).toEqual(['https://a.example', 'https://b.example']);
  });

  it('rejects an origin with a path — it would silently never match a real Origin header', () => {
    setRequired({ PUBLIC_WEB_ORIGIN: 'https://a.example/some/path' });
    expect(() => loadConfig()).toThrow(/must be an origin only/);
  });

  it('rejects an origin with a trailing slash', () => {
    setRequired({ PUBLIC_WEB_ORIGIN: 'https://a.example/' });
    expect(() => loadConfig()).toThrow(/must be an origin only/);
  });

  it('rejects garbage', () => {
    setRequired({ PUBLIC_WEB_ORIGIN: 'not an origin' });
    expect(() => loadConfig()).toThrow(/is not a valid origin/);
  });
});

describe('loadConfig — PUBLIC_WEB_ORIGIN_PATTERNS (#28: Vercel preview deploys)', () => {
  const VERCEL_PREVIEW = 'https://pixel-index-*-acme-team.vercel.app';

  it('is absent by default — matching stays exact unless you opt in', () => {
    setRequired();
    const config = loadConfig();
    expect(config.webOriginPatterns).toEqual([]);
    expect(allowsWebOrigin(config, 'https://pixel-index-abc123-acme-team.vercel.app')).toBe(false);
  });

  it('matches a per-deploy preview hostname the exact list cannot enumerate', () => {
    setRequired({ PUBLIC_WEB_ORIGIN_PATTERNS: VERCEL_PREVIEW });
    const config = loadConfig();
    expect(allowsWebOrigin(config, 'https://pixel-index-abc123-acme-team.vercel.app')).toBe(true);
    expect(allowsWebOrigin(config, 'https://pixel-index-699uclg0a-acme-team.vercel.app')).toBe(true);
  });

  it('still allows the exact PUBLIC_WEB_ORIGIN entries alongside the patterns', () => {
    setRequired({ PUBLIC_WEB_ORIGIN_PATTERNS: VERCEL_PREVIEW });
    expect(allowsWebOrigin(loadConfig(), 'https://pixel-index.example')).toBe(true);
  });

  it('accepts several comma-separated patterns', () => {
    setRequired({
      PUBLIC_WEB_ORIGIN_PATTERNS: `${VERCEL_PREVIEW}, https://deploy-preview-*--acme.netlify.app`,
    });
    const config = loadConfig();
    expect(config.webOriginPatterns).toHaveLength(2);
    expect(allowsWebOrigin(config, 'https://deploy-preview-42--acme.netlify.app')).toBe(true);
  });

  it('never lets the wildcard cross a dot — the whole point of the label restriction', () => {
    setRequired({ PUBLIC_WEB_ORIGIN_PATTERNS: 'https://pixel-index-*.example.com' });
    const config = loadConfig();
    expect(allowsWebOrigin(config, 'https://pixel-index-preview.example.com')).toBe(true);
    expect(allowsWebOrigin(config, 'https://pixel-index-.evil.example.com')).toBe(false);
    expect(allowsWebOrigin(config, 'https://pixel-index-x.evil.example.com')).toBe(false);
  });

  it('anchors both ends, so a prefix or suffix cannot be tacked on', () => {
    setRequired({ PUBLIC_WEB_ORIGIN_PATTERNS: VERCEL_PREVIEW });
    const config = loadConfig();
    expect(allowsWebOrigin(config, 'https://evil-pixel-index-abc-acme-team.vercel.app')).toBe(false);
    expect(allowsWebOrigin(config, 'https://pixel-index-abc-acme-team.vercel.app.evil.test')).toBe(false);
  });

  it('requires the wildcard to expand to something — an empty label is not a match', () => {
    setRequired({ PUBLIC_WEB_ORIGIN_PATTERNS: VERCEL_PREVIEW });
    expect(allowsWebOrigin(loadConfig(), 'https://pixel-index--acme-team.vercel.app')).toBe(false);
  });

  it('rejects a whole-label wildcard — it would cover every project on a shared domain', () => {
    setRequired({ PUBLIC_WEB_ORIGIN_PATTERNS: 'https://*.vercel.app' });
    expect(() => loadConfig()).toThrow(/too broad/);
  });

  it('rejects more than one wildcard', () => {
    setRequired({ PUBLIC_WEB_ORIGIN_PATTERNS: 'https://a-*-b-*.example.com' });
    expect(() => loadConfig()).toThrow(/exactly one "\*"/);
  });

  it('rejects a pattern with no wildcard — that belongs in PUBLIC_WEB_ORIGIN', () => {
    setRequired({ PUBLIC_WEB_ORIGIN_PATTERNS: 'https://exact.example.com' });
    expect(() => loadConfig()).toThrow(/exactly one "\*"/);
  });

  it('rejects http — a credentialed wildcard over cleartext is not defensible', () => {
    setRequired({ PUBLIC_WEB_ORIGIN_PATTERNS: 'http://pixel-index-*.example.com' });
    expect(() => loadConfig()).toThrow(/must use https/);
  });

  it('rejects a pattern with a path or trailing slash', () => {
    setRequired({ PUBLIC_WEB_ORIGIN_PATTERNS: 'https://pixel-index-*.example.com/' });
    expect(() => loadConfig()).toThrow(/must be an origin only/);
  });

  it('rejects garbage', () => {
    setRequired({ PUBLIC_WEB_ORIGIN_PATTERNS: 'not-an-origin-*' });
    expect(() => loadConfig()).toThrow(/is not a valid origin/);
  });

  it('reports a bad pattern alongside every other problem, not one restart at a time', () => {
    setRequired({ PUBLIC_WEB_ORIGIN_PATTERNS: 'https://*.vercel.app', SESSION_SECRET: 'short' });
    try {
      loadConfig();
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('PUBLIC_WEB_ORIGIN_PATTERNS');
      expect(message).toContain('SESSION_SECRET');
    }
  });
});

describe('loadConfig — PUBLIC_API_ORIGIN', () => {
  it('accepts exactly one origin', () => {
    setRequired({ PUBLIC_API_ORIGIN: 'https://api.example' });
    expect(loadConfig().publicApiOrigin).toBe('https://api.example');
  });

  it('rejects a path — this is what redirect_uri is built from, and it must be exact', () => {
    setRequired({ PUBLIC_API_ORIGIN: 'https://api.example/v1' });
    expect(() => loadConfig()).toThrow(/PUBLIC_API_ORIGIN must be an origin only/);
  });

  it('rejects garbage', () => {
    setRequired({ PUBLIC_API_ORIGIN: 'not a url' });
    expect(() => loadConfig()).toThrow(/PUBLIC_API_ORIGIN is not a valid origin/);
  });
});

describe('loadConfig — SESSION_SECRET', () => {
  it('accepts a secret at the minimum length', () => {
    setRequired({ SESSION_SECRET: 'x'.repeat(32) });
    expect(loadConfig().sessionSecret).toHaveLength(32);
  });

  it('rejects a short secret — short signing keys are brute-forceable', () => {
    setRequired({ SESSION_SECRET: 'too-short' });
    expect(() => loadConfig()).toThrow(/SESSION_SECRET must be at least 32 characters/);
  });
});

describe('loadConfig — WEBHOOK_SECRET_ENCRYPTION_KEY', () => {
  it('accepts exactly 32 decoded bytes', () => {
    setRequired();
    expect(Buffer.from(loadConfig().webhookSecretEncryptionKey, 'base64')).toHaveLength(32);
  });

  it('rejects a malformed or short key', () => {
    setRequired({ WEBHOOK_SECRET_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') });
    expect(() => loadConfig()).toThrow(/WEBHOOK_SECRET_ENCRYPTION_KEY.*exactly 32 bytes/);
  });
});

describe('loadConfig — BACKUP_API_KEY (#63)', () => {
  it('is unset by default — the scheduled backup workflow is opt-in', () => {
    setRequired();
    expect(loadConfig().backupApiKey).toBeUndefined();
  });

  it('accepts a key at the minimum length', () => {
    setRequired({ BACKUP_API_KEY: 'x'.repeat(32) });
    expect(loadConfig().backupApiKey).toHaveLength(32);
  });

  it('rejects a short key — short shared secrets are brute-forceable', () => {
    setRequired({ BACKUP_API_KEY: 'too-short' });
    expect(() => loadConfig()).toThrow(/BACKUP_API_KEY must be at least 32 characters/);
  });
});

describe('loadConfig — auth extras', () => {
  it('community integration is optional for self-hosters', () => {
    setRequired();
    const config = loadConfig();
    expect(config.discordGuild).toBeUndefined();
    expect(config.discordAdminIds).toEqual([]);
  });

  it('rejects the removed one-off bootstrap variable', () => {
    setRequired({ INITIAL_ADMIN_DISCORD_ID: '123456789012345678' });
    expect(() => loadConfig()).toThrow(/INITIAL_ADMIN_DISCORD_ID is no longer supported/);
  });

  it('loads a Discord guild, admin users, moderator roles and the recommended cache TTL', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    setRequired({
      DISCORD_GUILD_ID: '1478428628709802166',
      DISCORD_ADMIN_IDS: '1528094749993599038, 77488778255540224',
      DISCORD_MODERATOR_ROLE_IDS: '1528065925264445622',
      DISCORD_INVITE_URL: 'https://discord.gg/pixel-index',
      DISCORD_OAUTH_TOKEN_ENCRYPTION_KEY: key,
    });
    const config = loadConfig();
    expect(config.discordAdminIds).toEqual(['1528094749993599038', '77488778255540224']);
    expect(config.discordGuild).toEqual({
      id: '1478428628709802166',
      moderatorRoleIds: ['1528065925264445622'],
      inviteUrl: 'https://discord.gg/pixel-index',
      oauthTokenEncryptionKey: key,
    });
    expect(config.discordMembershipCacheTtlMs).toBe(60_000);
  });

  it('requires an invite and a 32-byte encryption key when a guild is configured', () => {
    setRequired({ DISCORD_GUILD_ID: '1478428628709802166' });
    expect(() => loadConfig()).toThrow(/DISCORD_INVITE_URL is required/);
    expect(() => loadConfig()).toThrow(/DISCORD_OAUTH_TOKEN_ENCRYPTION_KEY is required/);
  });

  it('rejects malformed snowflakes and moderator roles without a guild', () => {
    setRequired({
      DISCORD_ADMIN_IDS: 'not-an-id',
      DISCORD_MODERATOR_ROLE_IDS: '1528065925264445622',
    });
    expect(() => loadConfig()).toThrow(/DISCORD_ADMIN_IDS/);
    expect(() => loadConfig()).toThrow(/DISCORD_MODERATOR_ROLE_IDS requires DISCORD_GUILD_ID/);
  });

  it('rejects an encryption key that is not exactly 32 decoded bytes', () => {
    setRequired({ DISCORD_OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') });
    expect(() => loadConfig()).toThrow(/exactly 32 bytes/);
  });

  it('has sane token TTL defaults: access shorter than refresh', () => {
    setRequired();
    const config = loadConfig();
    expect(config.accessTokenTtlMs).toBeLessThan(config.refreshTokenTtlMs);
    expect(config.loginCodeTtlMs).toBeLessThan(config.accessTokenTtlMs);
  });

  it('reads TTL overrides', () => {
    setRequired({
      ACCESS_TOKEN_TTL_MS: '1000',
      REFRESH_TOKEN_TTL_MS: '2000',
      LOGIN_CODE_TTL_MS: '3000',
    });
    const config = loadConfig();
    expect(config.accessTokenTtlMs).toBe(1000);
    expect(config.refreshTokenTtlMs).toBe(2000);
    expect(config.loginCodeTtlMs).toBe(3000);
  });
});

describe('loadConfig — submission limits (#8)', () => {
  it('has sane defaults matching the renderer\'s own default cap', () => {
    setRequired();
    const config = loadConfig();
    expect(config.maxLayoutBytes).toBe(2_000_000);
    expect(config.maxSubmissionsPerUserPerDay).toBe(20);
    expect(config.maxSharesPerUserPerDay).toBe(5);
  });

  it('reads overrides', () => {
    setRequired({ MAX_LAYOUT_BYTES: '500000', MAX_SUBMISSIONS_PER_USER_PER_DAY: '5', MAX_SHARES_PER_USER_PER_DAY: '3' });
    const config = loadConfig();
    expect(config.maxLayoutBytes).toBe(500_000);
    expect(config.maxSubmissionsPerUserPerDay).toBe(5);
    expect(config.maxSharesPerUserPerDay).toBe(3);
  });
});

describe('loadConfig — backup import limit (#63)', () => {
  it('defaults to 50MB, well above a single layout\'s cap', () => {
    setRequired();
    const config = loadConfig();
    expect(config.maxImportBytes).toBe(50_000_000);
  });

  it('reads an override', () => {
    setRequired({ MAX_IMPORT_BYTES: '1000000' });
    const config = loadConfig();
    expect(config.maxImportBytes).toBe(1_000_000);
  });
});

describe('loadConfig — upstream pin override (#6 /meta)', () => {
  it('is absent by default — auto-discovery is the normal path', () => {
    setRequired();
    expect('upstreamDir' in loadConfig()).toBe(false);
  });

  it('reads the directory when set', () => {
    setRequired({ PIXEL_AGENTS_DIR: '/opt/pixel-agents' });
    expect(loadConfig().upstreamDir).toBe('/opt/pixel-agents');
  });

  it('has no commit knob — the pin is read from the checkout, never configured', () => {
    // A container cannot read the submodule's git, so this used to be a
    // PIXEL_AGENTS_COMMIT build argument. Nobody passed it and every image
    // reported commit: null; it is a committed file now (upstream.ts).
    setRequired();
    expect('upstreamCommit' in loadConfig()).toBe(false);
  });
});

describe('loadConfig — API_COMMIT (#32)', () => {
  it('is absent by default — a local `npm run dev` has no Docker build arg to pass', () => {
    setRequired();
    expect('commit' in loadConfig()).toBe(false);
  });

  it('reads the commit baked in at build time', () => {
    setRequired({ API_COMMIT: 'a'.repeat(40) });
    expect(loadConfig().commit).toBe('a'.repeat(40));
  });
});

describe('loadConfig — defaults', () => {
  it('binds both IP stacks by default', () => {
    // Probing localhost resolves to ::1 first inside a container; binding
    // dual-stack is what makes an IPv4-only healthcheck (or vice versa) not a
    // trap here the way it was for the v1 static site.
    setRequired();
    expect(loadConfig().host).toBe('::');
  });

  it('trusts the reverse proxy by default', () => {
    setRequired();
    expect(loadConfig().trustProxy).toBe(true);
  });

  it('has sane rate-limit defaults, with the write bucket tighter than the general one', () => {
    setRequired();
    const config = loadConfig();
    expect(config.writeRateLimit.max).toBeLessThan(config.rateLimit.max);
  });

  it('gives the bulk export a tighter bucket still', () => {
    // It is the one read path whose cost scales with the size of the index, so
    // it must not share the general budget that lets a caller make 300 cheap
    // requests a minute (#26).
    setRequired();
    const config = loadConfig();
    expect(config.exportRateLimit.max).toBeLessThan(config.rateLimit.max);
  });
});

describe('loadConfig — overrides', () => {
  it('reads every numeric and boolean knob from the environment', () => {
    setRequired({
      API_PORT: '8080',
      API_BODY_LIMIT_BYTES: '1024',
      API_TRUST_PROXY: 'false',
      RATE_LIMIT_MAX: '10',
      RATE_LIMIT_WINDOW_MS: '5000',
      RATE_LIMIT_WRITE_MAX: '2',
      RATE_LIMIT_WRITE_WINDOW_MS: '1000',
      RATE_LIMIT_SHARE_MAX: '1',
      RATE_LIMIT_SHARE_WINDOW_MS: '300000',
      RATE_LIMIT_EXPORT_MAX: '3',
      RATE_LIMIT_EXPORT_WINDOW_MS: '2000',
    });
    const config = loadConfig();
    expect(config.port).toBe(8080);
    expect(config.bodyLimitBytes).toBe(1024);
    expect(config.trustProxy).toBe(false);
    expect(config.rateLimit).toEqual({ max: 10, windowMs: 5000 });
    expect(config.writeRateLimit).toEqual({ max: 2, windowMs: 1000 });
    expect(config.shareRateLimit).toEqual({ max: 1, windowMs: 300_000 });
    expect(config.exportRateLimit).toEqual({ max: 3, windowMs: 2000 });
  });

  it('rejects a non-boolean for API_TRUST_PROXY', () => {
    setRequired({ API_TRUST_PROXY: 'yes' });
    expect(() => loadConfig()).toThrow(/API_TRUST_PROXY must be "true" or "false"/);
  });

  it('rejects a negative number', () => {
    setRequired({ RATE_LIMIT_MAX: '-1' });
    expect(() => loadConfig()).toThrow(/RATE_LIMIT_MAX must be a non-negative number/);
  });

  it('rejects a non-numeric value', () => {
    setRequired({ API_PORT: 'eighty' });
    expect(() => loadConfig()).toThrow(/API_PORT must be a non-negative number/);
  });
});
