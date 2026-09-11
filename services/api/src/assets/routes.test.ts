import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signAccessToken } from '../auth/tokens.js';
import { PIXEL_AGENTS_SYSTEM_USER_ID } from '../db/constants.js';
import * as schema from '../db/schema.js';
import { createTestDatabase, type Harness } from '../db/test-support/harness.js';
import { buildServer } from '../server.js';
import { characterZip, simpleAssetZip } from '../test-support/assetZip.js';
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
    url: `/api/v1/assets?assetKind=furniture&name=${id}&category=${category}`,
    payload: await simpleAssetZip(id),
    headers: { 'content-type': 'application/zip', authorization: `Bearer ${accessToken}` },
  });
  return response.json<PublicCustomAssetDetail>();
}

async function publishCharacter(name: string) {
  const user = await insertUser(harness.db, { username: `author-of-${name}` });
  const accessToken = await signAccessToken(
    { sub: user.id, role: user.role },
    config.sessionSecret,
    config.accessTokenTtlMs,
  );
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/assets?assetKind=character&name=${name}`,
    payload: await characterZip(),
    headers: { 'content-type': 'application/zip', authorization: `Bearer ${accessToken}` },
  });
  return response.json<PublicCustomAssetDetail>();
}

/** A row shaped like `builtinSync.ts` would write, inserted directly — no HTTP endpoint creates these. */
async function insertBuiltinFurniture(id: string) {
  await harness.db.insert(schema.customAssets).values({
    assetKind: 'furniture',
    assetId: id,
    requestedAssetId: id,
    name: id,
    category: 'chairs',
    manifest: [
      {
        id,
        name: id,
        label: id,
        category: 'chairs',
        file: `${id}.png`,
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        canPlaceOnWalls: false,
        groupId: id,
      },
    ],
    sprites: { [id]: Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => '#ff00ff')) },
    rawZip: Buffer.from('fake zip'),
    authorUserId: PIXEL_AGENTS_SYSTEM_USER_ID,
    source: 'builtin',
    sourceCommit: '0'.repeat(40),
  });
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

  it('tags an upload as source: custom (#101 follow-up)', async () => {
    await publish('SOURCE_CUSTOM');
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets?limit=100' });
    const body = response.json<{ assets: { assetId: string; source: string }[] }>();
    expect(body.assets.find((a) => a.assetId === 'SOURCE_CUSTOM')?.source).toBe('custom');
  });

  it('filters by source, and interleaves both when unfiltered (#101 follow-up)', async () => {
    await publish('SOURCE_FILTER_CUSTOM');
    await insertBuiltinFurniture('SOURCE_FILTER_BUILTIN');

    const builtinOnly = await app.inject({ method: 'GET', url: '/api/v1/assets?source=builtin&limit=100' });
    const builtinBody = builtinOnly.json<{ assets: { assetId: string; source: string }[] }>();
    expect(builtinBody.assets.every((a) => a.source === 'builtin')).toBe(true);
    expect(builtinBody.assets.some((a) => a.assetId === 'SOURCE_FILTER_BUILTIN')).toBe(true);
    expect(builtinBody.assets.some((a) => a.assetId === 'SOURCE_FILTER_CUSTOM')).toBe(false);

    const both = await app.inject({ method: 'GET', url: '/api/v1/assets?limit=100' });
    const bothBody = both.json<{ assets: { assetId: string }[] }>();
    expect(bothBody.assets.some((a) => a.assetId === 'SOURCE_FILTER_BUILTIN')).toBe(true);
    expect(bothBody.assets.some((a) => a.assetId === 'SOURCE_FILTER_CUSTOM')).toBe(true);
  });

  it('filters by assetKind, so a gallery can narrow to just characters or pets', async () => {
    await publish('KIND_FILTER_CHAIR');
    await publishCharacter('KIND_FILTER_CHARACTER');

    const response = await app.inject({ method: 'GET', url: '/api/v1/assets?assetKind=character&limit=100' });
    const body = response.json<{ assets: { assetId: string; assetKind: string }[] }>();
    expect(body.assets.every((a) => a.assetKind === 'character')).toBe(true);
    expect(body.assets.some((a) => a.assetId === 'KIND_FILTER_CHARACTER')).toBe(true);
    expect(body.assets.some((a) => a.assetId === 'KIND_FILTER_CHAIR')).toBe(false);
  });

  it('400s for an unrecognized source', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets?source=bogus' });
    expect(response.statusCode).toBe(400);
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

describe('GET /api/v1/assets/schema/:kind (#107)', () => {
  it('serves the furniture manifest schema, unauthenticated', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/schema/furniture' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ $id: string; required: string[] }>();
    expect(body.$id).toContain('custom-asset-furniture-manifest.schema.json');
    expect(body.required).toContain('category');
  });

  it('serves the pet manifest schema, unauthenticated', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/schema/pet' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ $id: string; required: string[] }>();
    expect(body.$id).toContain('custom-asset-pet-manifest.schema.json');
    expect(body.required).toEqual(['id', 'name']);
  });

  it('404s for character — it has no manifest.json to have a schema for', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/schema/character' });
    expect(response.statusCode).toBe(404);
  });

  it('400s for an unrecognized kind', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/schema/bogus' });
    expect(response.statusCode).toBe(400);
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

  it('excludes builtin rows — the browser already has them from its own build-time bundle (#101 follow-up)', async () => {
    await insertBuiltinFurniture('CATALOG_BUILTIN_EXCLUDED');

    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/catalog' });
    const body = response.json<{ catalog: { id: string }[]; sprites: Record<string, unknown> }>();
    expect(body.catalog.some((entry) => entry.id === 'CATALOG_BUILTIN_EXCLUDED')).toBe(false);
    expect(body.sprites.CATALOG_BUILTIN_EXCLUDED).toBeUndefined();
  });
});
