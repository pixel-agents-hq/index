import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signAccessToken } from '../auth/tokens.js';
import { createTestDatabase, type Harness } from '../db/test-support/harness.js';
import type { EnvelopeBody } from '../errors.js';
import { buildServer } from '../server.js';
import { simpleAssetZip } from '../test-support/assetZip.js';
import { testConfig } from '../test-support/config.js';
import { insertUser } from '../test-support/layouts.js';
import type { PublicCustomAssetDetail } from './serialize.js';

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

async function tokenFor(overrides: Parameters<typeof insertUser>[1] = {}) {
  const user = await insertUser(harness.db, overrides);
  const accessToken = await signAccessToken(
    { sub: user.id, role: user.role },
    config.sessionSecret,
    config.accessTokenTtlMs,
  );
  return { user, accessToken };
}

function submit(query: string, zip: Buffer, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/assets?${query}`,
    payload: zip,
    headers: { 'content-type': 'application/zip', ...headers },
  });
}

describe('POST /api/v1/assets — authentication', () => {
  it('is impossible anonymously', async () => {
    const zip = await simpleAssetZip('ANON_CHAIR');
    const response = await submit('name=Chair&category=chairs', zip);
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /api/v1/assets — the happy path', () => {
  it('publishes immediately, no moderator review', async () => {
    const { accessToken, user } = await tokenFor({ username: 'uploader' });
    const zip = await simpleAssetZip('HAPPY_CHAIR');
    const response = await submit('name=Happy+Chair&category=chairs', zip, {
      authorization: `Bearer ${accessToken}`,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<PublicCustomAssetDetail>();
    expect(body.assetId).toBe('HAPPY_CHAIR');
    expect(body.name).toBe('Happy Chair');
    expect(body.author.username).toBe('uploader');
    expect(response.headers.location).toBe('/api/v1/assets/HAPPY_CHAIR');

    const fetched = await app.inject({ method: 'GET', url: `/api/v1/assets/${body.assetId}` });
    expect(fetched.statusCode).toBe(200);
    void user;
  });

  it('auto-suffixes a second upload that reuses the same id', async () => {
    const { accessToken: firstToken } = await tokenFor({ username: 'first-uploader' });
    const first = await submit('name=Dup&category=chairs', await simpleAssetZip('DUP_CHAIR'), {
      authorization: `Bearer ${firstToken}`,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json<PublicCustomAssetDetail>().assetId).toBe('DUP_CHAIR');

    const { accessToken: secondToken } = await tokenFor({ username: 'second-uploader' });
    const second = await submit('name=Dup+Two&category=chairs', await simpleAssetZip('DUP_CHAIR'), {
      authorization: `Bearer ${secondToken}`,
    });
    expect(second.statusCode).toBe(201);
    expect(second.json<PublicCustomAssetDetail>().assetId).toBe('DUP_CHAIR_2');
  });

  it('rejects an oversized upload before ever unzipping it', async () => {
    const tinyLimitConfig = testConfig({ writeRateLimit: { max: 1000, windowMs: 60_000 }, maxAssetZipBytes: 10 });
    const tinyApp = await buildServer({ config: tinyLimitConfig, pool: fakePool, db: harness.db });
    try {
      const { accessToken } = await tokenFor({ username: 'oversized-uploader' });
      const response = await tinyApp.inject({
        method: 'POST',
        url: '/api/v1/assets?name=Big&category=misc',
        payload: await simpleAssetZip('TOO_BIG'),
        headers: { 'content-type': 'application/zip', authorization: `Bearer ${accessToken}` },
      });
      expect(response.statusCode).toBe(413);
    } finally {
      await tinyApp.close();
    }
  });

  it('rejects an invalid manifest with field-level issues', async () => {
    const { accessToken } = await tokenFor({ username: 'bad-manifest-uploader' });
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ id: 'not valid id', type: 'asset' }));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const response = await submit('name=Bad&category=misc', buffer, {
      authorization: `Bearer ${accessToken}`,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<EnvelopeBody>().issues?.length).toBeGreaterThan(0);
  });
});
