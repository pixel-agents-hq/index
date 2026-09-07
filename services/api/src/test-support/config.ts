import type { ApiConfig } from '../config.js';

/** A fully valid config, so a test only has to override what it cares about. */
export function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    bodyLimitBytes: 5_000_000,
    trustProxy: true,
    databaseUrl: 'postgres://user:pass@localhost:5432/pixel_index',
    rendererUrl: 'http://renderer.internal:3000',
    webOrigins: ['https://pixel-index.example', 'https://preview.pixel-index.example'],
    webOriginPatterns: [],
    discordClientId: 'client-id',
    discordClientSecret: 'client-secret',
    discordAdminIds: [],
    discordMembershipCacheTtlMs: 60_000,
    publicApiOrigin: 'https://api.pixel-index.example',
    // 32+ chars, as loadConfig() itself requires.
    sessionSecret: 'test-session-secret-at-least-32-characters-long',
    webhookSecretEncryptionKey: Buffer.alloc(32, 9).toString('base64'),
    accessTokenTtlMs: 15 * 60_000,
    refreshTokenTtlMs: 30 * 24 * 60 * 60_000,
    loginCodeTtlMs: 60_000,
    maxLayoutBytes: 2_000_000,
    maxSubmissionsPerUserPerDay: 20,
    maxSharesPerUserPerDay: 5,
    rateLimit: { max: 100, windowMs: 60_000 },
    writeRateLimit: { max: 2, windowMs: 60_000 },
    shareRateLimit: { max: 1, windowMs: 5 * 60_000 },
    exportRateLimit: { max: 100, windowMs: 60_000 },
    maxImportBytes: 50_000_000,
    ...overrides,
  };
}
