import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signAccessToken } from '../auth/tokens.js';
import { createTestDatabase, type Harness } from '../db/test-support/harness.js';
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

async function publish(id: string, category = 'chairs') {
  const user = await insertUser(harness.db, { username: `author-of-${id}` });
  const accessToken = await signAccessToken(
    { sub: user.id, role: user.role },
    config.sessionSecret,
    config.accessTokenTtlMs,
  );
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/assets?name=${id}&category=${category}`,
    payload: await simpleAssetZip(id),
    headers: { 'content-type': 'application/zip', authorization: `Bearer ${accessToken}` },
  });
  return response.json<PublicCustomAssetDetail>();
}

describe('GET /api/v1/assets', () => {
  it('lists published assets, newest first', async () => {
    await publish('LIST_ONE');
    await publish('LIST_TWO');

    const response = await app.inject({ method: 'GET', url: '/api/v1/assets?limit=100' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ assets: { assetId: string }[] }>();
    const ids = body.assets.map((a) => a.assetId);
    expect(ids.indexOf('LIST_TWO')).toBeLessThan(ids.indexOf('LIST_ONE'));
  });

  it('filters by category', async () => {
    await publish('FILTER_CHAIR', 'chairs');
    await publish('FILTER_LAMP', 'decor');

    const response = await app.inject({ method: 'GET', url: '/api/v1/assets?category=decor&limit=100' });
    const body = response.json<{ assets: { assetId: string; category: string }[] }>();
    expect(body.assets.every((a) => a.category === 'decor')).toBe(true);
    expect(body.assets.some((a) => a.assetId === 'FILTER_LAMP')).toBe(true);
    expect(body.assets.some((a) => a.assetId === 'FILTER_CHAIR')).toBe(false);
  });
});

describe('GET /api/v1/assets/:assetId', () => {
  it('404s for an unknown id', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/NO_SUCH_ASSET' });
    expect(response.statusCode).toBe(404);
  });

  it('returns the full manifest for a known asset', async () => {
    await publish('DETAIL_CHAIR');
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/DETAIL_CHAIR' });
    expect(response.statusCode).toBe(200);
    const body = response.json<PublicCustomAssetDetail>();
    expect(body.manifest).toHaveLength(1);
  });
});

describe('GET /api/v1/assets/:assetId/sprite.png', () => {
  it('serves a real PNG', async () => {
    await publish('SPRITE_CHAIR');
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/SPRITE_CHAIR/sprite.png' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    // PNG magic bytes.
    expect(response.rawPayload.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });
});

describe('GET /api/v1/assets/catalog', () => {
  it('merges every published asset into one catalog+sprites payload', async () => {
    await publish('CATALOG_ONE');
    await publish('CATALOG_TWO');

    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/catalog' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ catalog: { id: string }[]; sprites: Record<string, unknown> }>();
    const ids = body.catalog.map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining(['CATALOG_ONE', 'CATALOG_TWO']));
    expect(body.sprites.CATALOG_ONE).toBeDefined();
    expect(body.sprites.CATALOG_TWO).toBeDefined();
  });
});
