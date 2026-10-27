import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { signAccessToken } from '../auth/tokens.js';
import { createTestDatabase, type Harness } from '../db/test-support/harness.js';
import { buildServer } from '../server.js';
import { testConfig } from '../test-support/config.js';
import { insertUser } from '../test-support/layouts.js';
import { profileAssetId } from './decodeProfile.js';
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
afterEach(() => {
  vi.unstubAllGlobals();
});

const frame = Array.from({ length: 32 }, () => Array.from({ length: 16 }, () => '#123456'));
const row = Array.from({ length: 8 }, () => frame);
const SPRITES = { down: row, up: row, right: row };

/** The renderer's `POST /compose-character`, answering as upstream's code would; every call recorded. */
function stubRenderer(answer: (body: { config: string; fileName: string }) => { status: number; json: unknown }) {
  const calls: { config: string; fileName: string }[] = [];
  vi.stubGlobal('fetch', async (url: URL | string, init?: RequestInit) => {
    if (!String(url).endsWith('/compose-character')) throw new Error(`unexpected fetch ${String(url)}`);
    const body = JSON.parse(init?.body as string) as { config: string; fileName: string };
    calls.push(body);
    const { status, json } = answer(body);
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}

const composes = () =>
  stubRenderer(({ config: text }) => ({
    status: 200,
    json: { profile: { ...(JSON.parse(text) as object), v: 35 }, sprites: SPRITES },
  }));

async function tokenFor() {
  const user = await insertUser(harness.db, {});
  const accessToken = await signAccessToken({ sub: user.id, role: user.role }, config.sessionSecret, config.accessTokenTtlMs);
  return { user, accessToken };
}

async function upload(profile: unknown, fileName = 'hero.json') {
  const { accessToken } = await tokenFor();
  return app.inject({
    method: 'POST',
    url: `/api/v1/assets?fileName=${encodeURIComponent(fileName)}`,
    payload: typeof profile === 'string' ? profile : JSON.stringify(profile),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
  });
}

describe('profileAssetId', () => {
  it('upper-snake-cases a name into an asset id that starts with a letter', () => {
    expect(profileAssetId('Office Hero')).toBe('OFFICE_HERO');
    expect(profileAssetId('  ünïcode – 42 ')).toBe('N_CODE_42');
    expect(profileAssetId('42')).toBe('CHARACTER_42');
    expect(profileAssetId('!!!')).toBe('CHARACTER');
  });
});

describe('POST /api/v1/assets — a character profile (Characters view config JSON)', () => {
  it('publishes it as a character tagged profile, with the sprites the renderer composed', async () => {
    const calls = composes();
    const response = await upload({ name: 'Night Owl', body: 'flat', hair: 'mop' }, 'owl.json');
    expect(response.statusCode).toBe(201);
    const body = response.json<PublicCustomAssetDetail>();
    expect(body).toMatchObject({ assetId: 'NIGHT_OWL', assetKind: 'character', name: 'Night Owl', category: null });
    expect(body.tags).toEqual(['animated', 'profile']);
    // The config reached the renderer verbatim, with its file name.
    expect(calls).toEqual([{ config: JSON.stringify({ name: 'Night Owl', body: 'flat', hair: 'mop' }), fileName: 'owl.json' }]);

    // The frames power the same poses endpoint any character has (8 frames: walk, typing, reading, seated).
    const frames = await app.inject({ method: 'GET', url: '/api/v1/assets/NIGHT_OWL/frames' });
    expect(frames.json<{ poses: { key: string }[] }>().poses.map((p) => p.key)).toContain('seated-down');

    // And it comes back as the config upstream's "Load config" reads — as upstream migrated it.
    const config = await app.inject({ method: 'GET', url: '/api/v1/assets/NIGHT_OWL/profile.json' });
    expect(config.statusCode).toBe(200);
    expect(config.headers['content-disposition']).toBe('attachment; filename="NIGHT_OWL.json"');
    expect(config.json()).toEqual({ name: 'Night Owl', body: 'flat', hair: 'mop', v: 35 });

    // The download zip carries the config beside the char_N.png sheet.
    const zipResponse = await app.inject({ method: 'GET', url: '/api/v1/assets/NIGHT_OWL/download' });
    const zip = await JSZip.loadAsync(zipResponse.rawPayload);
    expect(zip.file('assets/characters/char_0.png')).not.toBeNull();
    expect(JSON.parse((await zip.file('character-profiles/NIGHT_OWL.json')?.async('string')) ?? '')).toMatchObject({
      name: 'Night Owl',
    });
  });

  it('is found by the profile filter, and a sprite-sheet character is not', async () => {
    composes();
    expect((await upload({ name: 'Filter Me', body: 'flat' })).statusCode).toBe(201);
    const profiles = await app.inject({ method: 'GET', url: '/api/v1/assets?profile=true' });
    const names = profiles.json<{ assets: { name: string; tags: string[] }[] }>().assets.map((a) => a.name);
    expect(names).toContain('Filter Me');
    const sheets = await app.inject({ method: 'GET', url: '/api/v1/assets?profile=false&assetKind=character' });
    expect(sheets.json<{ assets: { name: string }[] }>().assets.map((a) => a.name)).not.toContain('Filter Me');
  });

  it('suffixes a name another asset already took', async () => {
    composes();
    expect((await upload({ name: 'Twin', body: 'flat' })).json<PublicCustomAssetDetail>().assetId).toBe('TWIN');
    expect((await upload({ name: 'Twin', body: 'flat' })).json<PublicCustomAssetDetail>().assetId).toBe('TWIN_2');
  });

  it('refuses what upstream refuses, with upstream’s reason', async () => {
    stubRenderer(() => ({ status: 422, json: { error: 'invalid_profile', message: 'Pixel Agents could not read this file as a character config.' } }));
    const response = await upload({ name: 'Bad', body: 'no-such-body' });
    expect(response.statusCode).toBe(422);
    expect(JSON.stringify(response.json())).toContain('could not read this file as a character config');
  });

  it('refuses a roster or broken JSON without asking the renderer', async () => {
    const calls = composes();
    const roster = await upload([{ body: 'flat' }, { body: 'flat' }]);
    expect(roster.statusCode).toBe(422);
    expect(JSON.stringify(roster.json())).toContain('one character config at a time');
    expect((await upload({ roster: [{ body: 'flat' }] })).statusCode).toBe(422);
    expect((await upload('{ "body": ')).statusCode).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('answers 502 when the renderer is down, and stores nothing', async () => {
    stubRenderer(() => ({ status: 503, json: { error: 'down' } }));
    const response = await upload({ name: 'Lost', body: 'flat' });
    expect(response.statusCode).toBe(502);
    expect((await app.inject({ method: 'GET', url: '/api/v1/assets/LOST' })).statusCode).toBe(404);
  });

  it('serves profile.json only for profiles', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/NO_SUCH_THING/profile.json' });
    expect(response.statusCode).toBe(404);
  });
});
