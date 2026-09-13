import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signAccessToken } from '../auth/tokens.js';
import { PIXEL_AGENTS_SYSTEM_USER_ID } from '../db/constants.js';
import * as schema from '../db/schema.js';
import { createTestDatabase, type Harness } from '../db/test-support/harness.js';
import { buildServer } from '../server.js';
import { characterZip, petZip, rotationAssetZip, simpleAssetZip } from '../test-support/assetZip.js';
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
    url: '/api/v1/assets',
    payload: await simpleAssetZip(id, { name: id, category }),
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
    url: '/api/v1/assets',
    payload: await characterZip(name, name),
    headers: { 'content-type': 'application/zip', authorization: `Bearer ${accessToken}` },
  });
  return response.json<PublicCustomAssetDetail>();
}

async function publishPet(id: string) {
  const user = await insertUser(harness.db, { username: `author-of-${id}` });
  const accessToken = await signAccessToken(
    { sub: user.id, role: user.role },
    config.sessionSecret,
    config.accessTokenTtlMs,
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    payload: await petZip(id, id),
    headers: { 'content-type': 'application/zip', authorization: `Bearer ${accessToken}` },
  });
  return response.json<PublicCustomAssetDetail>();
}

async function publishRotation(id: string) {
  const user = await insertUser(harness.db, { username: `author-of-${id}` });
  const accessToken = await signAccessToken(
    { sub: user.id, role: user.role },
    config.sessionSecret,
    config.accessTokenTtlMs,
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    payload: await rotationAssetZip(id),
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

describe('GET /api/v1/assets/:assetId/frames', () => {
  it('404s for an unknown id', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/NO_SUCH_ASSET/frames' });
    expect(response.statusCode).toBe(404);
  });

  it('gives a flat furniture asset one pose with one frame', async () => {
    await publish('FRAMES_CHAIR');
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/FRAMES_CHAIR/frames' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ poses: { key: string; label: string; frames: string[] }[] }>();
    expect(body.poses).toHaveLength(1);
    expect(body.poses[0]?.frames).toHaveLength(1);
    expect(body.poses[0]?.frames[0]).toMatch(/^data:image\/png;base64,/);
  });

  it('gives a character asset a walking pose per direction, with a mirrored left, plus typing/reading poses', async () => {
    await publishCharacter('FRAMES_CHARACTER');
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/FRAMES_CHARACTER/frames' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ poses: { key: string; mirror?: boolean; frames: string[] }[] }>();
    expect(body.poses.map((p) => p.key)).toEqual([
      'down',
      'up',
      'right',
      'left',
      'typing-down',
      'typing-up',
      'typing-right',
      'typing-left',
      'reading-down',
      'reading-up',
      'reading-right',
      'reading-left',
    ]);
    expect(body.poses.find((p) => p.key === 'left')?.mirror).toBe(true);
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

  it('serves the character manifest schema, unauthenticated', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/schema/character' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ $id: string; required: string[] }>();
    expect(body.$id).toContain('custom-asset-character-manifest.schema.json');
    expect(body.required).toEqual(['id', 'name']);
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

describe('GET /api/v1/assets/:assetId/download (#119)', () => {
  it('404s for an unknown id', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/NO_SUCH_ASSET/download' });
    expect(response.statusCode).toBe(404);
  });

  it('404s for a builtin id — already available from vendor/pixel-agents itself', async () => {
    await insertBuiltinFurniture('DOWNLOAD_BUILTIN_EXCLUDED');
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/DOWNLOAD_BUILTIN_EXCLUDED/download' });
    expect(response.statusCode).toBe(404);
  });

  it('serves a pixel-agents-importable zip for a simple furniture asset', async () => {
    await publish('DOWNLOAD_CHAIR');
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/DOWNLOAD_CHAIR/download' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toBe('attachment; filename="DOWNLOAD_CHAIR.zip"');

    const zip = await JSZip.loadAsync(response.rawPayload);
    const manifestFile = zip.file('assets/furniture/DOWNLOAD_CHAIR/manifest.json');
    expect(manifestFile).not.toBeNull();
    const manifest = JSON.parse((await manifestFile?.async('text')) ?? '{}') as { type: string; id: string };
    expect(manifest.type).toBe('asset');
    expect(manifest.id).toBe('DOWNLOAD_CHAIR');
    expect(zip.file('assets/furniture/DOWNLOAD_CHAIR/DOWNLOAD_CHAIR.png')).not.toBeNull();
  });

  it('reconstructs a nested rotation group manifest with per-member orientation', async () => {
    await publishRotation('DOWNLOAD_DESK');
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/DOWNLOAD_DESK/download' });
    expect(response.statusCode).toBe(200);

    const zip = await JSZip.loadAsync(response.rawPayload);
    const manifestFile = zip.file('assets/furniture/DOWNLOAD_DESK/manifest.json');
    const manifest = JSON.parse((await manifestFile?.async('text')) ?? '{}') as {
      type: string;
      groupType: string;
      rotationScheme: string;
      members: { id: string; orientation: string; file: string }[];
    };
    expect(manifest.type).toBe('group');
    expect(manifest.groupType).toBe('rotation');
    expect(manifest.rotationScheme).toBe('2-way');
    expect(manifest.members).toHaveLength(2);
    const front = manifest.members.find((m) => m.orientation === 'front');
    expect(front).toBeDefined();
    expect(front?.id).toBe('DOWNLOAD_DESK_FRONT');
    expect(zip.file(`assets/furniture/DOWNLOAD_DESK/${front?.file ?? ''}`)).not.toBeNull();
  });

  it('serves a pixel-agents-importable pet.png + manifest.json', async () => {
    await publishPet('DOWNLOAD_PET');
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/DOWNLOAD_PET/download' });
    expect(response.statusCode).toBe(200);

    const zip = await JSZip.loadAsync(response.rawPayload);
    const manifestFile = zip.file('assets/pets/DOWNLOAD_PET/manifest.json');
    expect(manifestFile).not.toBeNull();
    const manifest = JSON.parse((await manifestFile?.async('text')) ?? '{}') as { id: string; name: string };
    expect(manifest).toEqual({ id: 'DOWNLOAD_PET', name: 'DOWNLOAD_PET' });
    expect(zip.file('assets/pets/DOWNLOAD_PET/pet.png')).not.toBeNull();
  });

  it('serves a bare char_0.png for a character — no manifest.json (#119 decision)', async () => {
    await publishCharacter('DOWNLOAD_HERO');
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/DOWNLOAD_HERO/download' });
    expect(response.statusCode).toBe(200);

    const zip = await JSZip.loadAsync(response.rawPayload);
    expect(zip.file('assets/characters/char_0.png')).not.toBeNull();
    expect(Object.keys(zip.files).filter((name) => name.includes('manifest.json'))).toHaveLength(0);
  });

  it('returns a 304 when If-None-Match matches', async () => {
    await publish('DOWNLOAD_ETAG');
    const first = await app.inject({ method: 'GET', url: '/api/v1/assets/DOWNLOAD_ETAG/download' });
    const etag = first.headers.etag as string;
    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/DOWNLOAD_ETAG/download',
      headers: { 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(304);
  });
});

describe('GET /api/v1/assets/download (#119)', () => {
  it('400s with no ids', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/download?ids=' });
    expect(response.statusCode).toBe(400);
  });

  it('400s over the id cap', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `ID_${i}`).join(',');
    const response = await app.inject({ method: 'GET', url: `/api/v1/assets/download?ids=${ids}` });
    expect(response.statusCode).toBe(400);
  });

  it('404s the whole request if any id is unknown — never silently drops a selection', async () => {
    await publish('MULTI_KNOWN');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/download?ids=MULTI_KNOWN,NO_SUCH_ASSET',
    });
    expect(response.statusCode).toBe(404);
  });

  it('404s the whole request if any id is a builtin', async () => {
    await publish('MULTI_CUSTOM');
    await insertBuiltinFurniture('MULTI_BUILTIN');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/download?ids=MULTI_CUSTOM,MULTI_BUILTIN',
    });
    expect(response.statusCode).toBe(404);
  });

  it('bundles a mixed-kind selection into one zip, numbering characters sequentially in selection order', async () => {
    await publish('MULTI_CHAIR');
    await publishCharacter('MULTI_HERO_ONE');
    await publishCharacter('MULTI_HERO_TWO');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/download?ids=MULTI_CHAIR,MULTI_HERO_ONE,MULTI_HERO_TWO',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe('attachment; filename="pixel-index-assets.zip"');

    const zip = await JSZip.loadAsync(response.rawPayload);
    expect(zip.file('assets/furniture/MULTI_CHAIR/manifest.json')).not.toBeNull();
    expect(zip.file('assets/characters/char_0.png')).not.toBeNull();
    expect(zip.file('assets/characters/char_1.png')).not.toBeNull();
  });

  it('dedupes repeated ids', async () => {
    await publish('MULTI_DEDUPE');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/download?ids=MULTI_DEDUPE,MULTI_DEDUPE',
    });
    expect(response.statusCode).toBe(200);
    const zip = await JSZip.loadAsync(response.rawPayload);
    expect(zip.file('assets/furniture/MULTI_DEDUPE/manifest.json')).not.toBeNull();
  });
});
