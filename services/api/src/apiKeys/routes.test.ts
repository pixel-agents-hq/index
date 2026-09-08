import type { FastifyInstance } from 'fastify';
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest';

import { signAccessToken } from '../auth/tokens.js';
import { createTestDatabase, type Harness } from '../db/test-support/harness.js';
import { buildServer } from '../server.js';
import { simpleAssetZip } from '../test-support/assetZip.js';
import { testConfig } from '../test-support/config.js';
import { insertUser } from '../test-support/layouts.js';
import type { ApiKeyView } from './serialize.js';

const config = testConfig({ writeRateLimit: { max: 1000, windowMs: 60_000 } });
const fakePool = { query: async () => ({ rows: [] }) };

let harness: Harness;
let app: FastifyInstance;
beforeAll(async () => {
  harness = await createTestDatabase();
  app = await buildServer({ config, pool: fakePool, db: harness.db });
});
afterAll(async () => {
  await app.close();
  await harness.close();
});

async function tokenFor(role: 'user' | 'moderator' | 'admin', username: string) {
  const user = await insertUser(harness.db, { username, role });
  if (role === 'moderator' || role === 'admin') {
    // No Discord guild is configured in these tests, so `resolveCapability`
    // (auth/capability.ts) only ever grants 'admin' or 'user' — same
    // convention `layouts/manage.test.ts` establishes for exercising a
    // moderator-gated route without a real guild.
    assert(user.discordId !== null, 'insertUser did not give this user a Discord id');
    config.discordAdminIds.push(user.discordId);
  }
  const accessToken = await signAccessToken(
    { sub: user.id, role: user.role },
    config.sessionSecret,
    config.accessTokenTtlMs,
  );
  return { user, accessToken };
}

describe('POST /api/v1/moderation/api-keys', () => {
  it('is forbidden for a non-moderator', async () => {
    const { accessToken } = await tokenFor('user', 'plain-user');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/api-keys',
      payload: { label: 'animator bot' },
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it('lets a moderator mint a key, shown once', async () => {
    const { accessToken } = await tokenFor('moderator', 'mod-one');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/api-keys',
      payload: { label: 'animator bot' },
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<ApiKeyView & { value: string }>();
    expect(body.label).toBe('animator bot');
    expect(body.revoked).toBe(false);
    expect(body.value).toBeTruthy();

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/moderation/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const listed = list.json<{ keys: ApiKeyView[] }>().keys;
    expect(listed.some((k) => k.id === body.id)).toBe(true);
    // The list view never carries the plaintext or the hash.
    expect(listed.find((k) => k.id === body.id)).not.toHaveProperty('value');
  });

  it('revokes a key, which then fails to authenticate an upload', async () => {
    const { accessToken } = await tokenFor('moderator', 'mod-two');
    const issued = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/api-keys',
      payload: { label: 'revoke-me' },
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const { id, value } = issued.json<ApiKeyView & { value: string }>();

    const revoke = await app.inject({
      method: 'POST',
      url: `/api/v1/moderation/api-keys/${id}/revoke`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json<ApiKeyView>().revoked).toBe(true);

    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/assets?name=Revoked+Test&category=misc&discordUserId=111111111111111111',
      payload: await simpleAssetZip('REVOKED_KEY_TEST'),
      headers: { 'content-type': 'application/zip', 'x-api-key': value },
    });
    expect(upload.statusCode).toBe(401);
  });

  it('404s revoking an unknown key', async () => {
    const { accessToken } = await tokenFor('moderator', 'mod-three');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/api-keys/00000000-0000-0000-0000-000000000000/revoke',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(404);
  });
});
