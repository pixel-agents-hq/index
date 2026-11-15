import { pixatar, PixatarError, seedFromText, VENDOR } from '@pixel-index/pixatar';
import type { FastifyInstance } from 'fastify';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ApiConfig } from '../config.js';
import type { AnyDatabase } from '../db/client.js';
import type { EnvelopeBody } from '../errors.js';
import { buildServer } from '../server.js';
import { testConfig } from '../test-support/config.js';
import { AVATAR_CACHE_CONTROL, clearAvatarCache, MAX_SEED_CODE_LENGTH, redactAvatarUrl } from './render.js';

/** The avatar route never touches the database. */
const unusedDb = {} as AnyDatabase;
const pool = { query: () => Promise.resolve({ rows: [] }) };

let apps: FastifyInstance[] = [];
beforeEach(() => clearAvatarCache());
afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

async function build(config: ApiConfig = testConfig()) {
  const app = await buildServer({ config, pool, db: unusedDb });
  apps.push(app);
  return app;
}

const OCTOCAT = seedFromText('octocat');
const url = (seed: string, query = '') => `/api/v1/avatars/${seed}.png${query}`;

/** A well-formed code naming a part this wardrobe doesn't have, found rather than hard-coded, so a vendor bump can't quietly make it valid. */
function codeWithUnknownPart(): string {
  const bytes = Buffer.from(OCTOCAT.slice(3), 'base64url');
  for (let i = 1; i < bytes.length; i++) {
    for (const value of [0x00, 0xff, 0xfe, 0x7f]) {
      const mutated = Buffer.from(bytes);
      mutated[i] = value;
      const code = `px.${mutated.toString('base64url')}`;
      try {
        pixatar(code);
      } catch (error) {
        if (error instanceof PixatarError && error.code === 'unknown-part') return code;
      }
    }
  }
  throw new Error('no single-byte mutation names an unknown part');
}

describe('GET /api/v1/avatars/:seed.png', () => {
  it("serves the package's own avatar PNG for a seed code, at scale 8 by default", async () => {
    const app = await build();
    const response = await app.inject({ method: 'GET', url: url(OCTOCAT) });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.rawPayload.equals(Buffer.from(pixatar(OCTOCAT).avatarPng({ scale: 8 })))).toBe(true);
    const png = PNG.sync.read(response.rawPayload);
    expect([png.width, png.height]).toEqual([160, 160]);
  });

  it('takes ?scale= from 1 to 16', async () => {
    const app = await build();
    for (const scale of [1, 16]) {
      const response = await app.inject({ method: 'GET', url: url(OCTOCAT, `?scale=${scale}`) });
      expect(response.statusCode).toBe(200);
      expect(PNG.sync.read(response.rawPayload).width).toBe(20 * scale);
    }
  });

  it.each(['0', '17', '64', '1.5', 'big', ''])('refuses ?scale=%s', async (scale) => {
    const app = await build();
    const response = await app.inject({ method: 'GET', url: url(OCTOCAT, `?scale=${scale}`) });
    expect(response.statusCode).toBe(400);
    expect(response.json<EnvelopeBody>().error).toBe('bad_request');
  });

  it('draws on nothing with ?background=transparent, and on the colour with ?background=color', async () => {
    const app = await build();
    const clear = await app.inject({ method: 'GET', url: url(OCTOCAT, '?background=transparent&scale=1') });
    expect(clear.statusCode).toBe(200);
    expect(PNG.sync.read(clear.rawPayload).data[3]).toBe(0);

    const transparentCode = seedFromText('octocat', { background: 'transparent' });
    const colour = await app.inject({ method: 'GET', url: url(transparentCode, '?background=color&scale=1') });
    expect(colour.statusCode).toBe(200);
    expect(PNG.sync.read(colour.rawPayload).data[3]).toBe(255);

    // Omitted: as the code says.
    const asCoded = await app.inject({ method: 'GET', url: url(transparentCode, '?scale=1') });
    expect(asCoded.rawPayload.equals(clear.rawPayload)).toBe(true);
  });

  it('refuses an unknown ?background= and any unknown query parameter', async () => {
    const app = await build();
    for (const query of ['?background=red', '?size=8', '?scale=8&text=octocat']) {
      const response = await app.inject({ method: 'GET', url: url(OCTOCAT, query) });
      expect(response.statusCode, query).toBe(400);
    }
  });

  it('never draws free text: it can carry an email address, which would sit in access logs', async () => {
    const app = await build();
    for (const seed of ['octocat', 'someone%40example.com', 'PX.abc']) {
      const response = await app.inject({ method: 'GET', url: url(seed) });
      expect(response.statusCode, seed).toBe(400);
      const body = response.json<EnvelopeBody>();
      expect(body.error).toBe('invalid_seed');
      expect(body.message).toMatch(/seedFromText/);
    }
  });

  it('refuses a malformed or damaged seed code with invalid_seed', async () => {
    const app = await build();
    for (const seed of ['px.', 'px.AAAA', 'px.has%20space', 'px.a.b', `px.${'A'.repeat(MAX_SEED_CODE_LENGTH)}`]) {
      const response = await app.inject({ method: 'GET', url: url(seed) });
      expect(response.statusCode, seed).toBe(400);
      expect(response.json<EnvelopeBody>().error, seed).toBe('invalid_seed');
    }
  });

  it('answers 422 unknown_part for a code made with a larger wardrobe', async () => {
    const app = await build();
    const response = await app.inject({ method: 'GET', url: url(codeWithUnknownPart()) });
    expect(response.statusCode).toBe(422);
    expect(response.json<EnvelopeBody>().error).toBe('unknown_part');
  });

  it("draws codes longer than the router's default 100-character parameter", async () => {
    const app = await build();
    let long = OCTOCAT;
    for (let i = 0; long.length <= 100; i++) long = seedFromText(`long-${i}`);
    const response = await app.inject({ method: 'GET', url: url(long) });
    expect(response.statusCode).toBe(200);
  });

  it('is 404 without the .png extension', async () => {
    const app = await build();
    const response = await app.inject({ method: 'GET', url: `/api/v1/avatars/${OCTOCAT}` });
    expect(response.statusCode).toBe(404);
  });

  it('is cacheable, with a strong ETag that turns a repeat into a 304', async () => {
    const app = await build();
    const first = await app.inject({ method: 'GET', url: url(OCTOCAT) });
    expect(first.headers['cache-control']).toBe(AVATAR_CACHE_CONTROL);
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect(first.headers['x-pixatar-vendor']).toBe(VENDOR.commit);
    const etag = first.headers.etag;
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);

    const again = await app.inject({ method: 'GET', url: url(OCTOCAT), headers: { 'if-none-match': String(etag) } });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);

    // A different scale is different bytes, so a different tag.
    const bigger = await app.inject({ method: 'GET', url: url(OCTOCAT, '?scale=9') });
    expect(bigger.headers.etag).not.toBe(etag);
  });

  it('gives the same bytes and tag whether rendered or cached', async () => {
    const app = await build();
    const rendered = await app.inject({ method: 'GET', url: url(OCTOCAT) });
    const cached = await app.inject({ method: 'GET', url: url(OCTOCAT) });
    clearAvatarCache();
    const rerendered = await app.inject({ method: 'GET', url: url(OCTOCAT) });
    expect(cached.rawPayload.equals(rendered.rawPayload)).toBe(true);
    expect(rerendered.headers.etag).toBe(rendered.headers.etag);
  });

  it('answers HEAD', async () => {
    const app = await build();
    const response = await app.inject({ method: 'HEAD', url: url(OCTOCAT) });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
  });

  it('needs no login and is readable from any origin', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'GET',
      url: url(OCTOCAT),
      headers: { origin: 'https://pixel-index.example' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('has its own rate-limit bucket', async () => {
    const app = await build(
      testConfig({ rateLimit: { max: 100, windowMs: 60_000 }, avatarRateLimit: { max: 2, windowMs: 60_000 } }),
    );
    for (let i = 0; i < 2; i++) {
      expect((await app.inject({ method: 'GET', url: url(OCTOCAT) })).statusCode).toBe(200);
    }
    const limited = await app.inject({ method: 'GET', url: url(OCTOCAT) });
    expect(limited.statusCode).toBe(429);
    expect(limited.json<EnvelopeBody>().error).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBeDefined();

    // Other routes still have the general bucket.
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('is in the OpenAPI document', async () => {
    const app = await build();
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, { get?: { parameters?: { name: string }[] } }>;
    }>();
    const route = doc.paths['/api/v1/avatars/{seed}.png'];
    expect(route?.get?.parameters?.map((p) => p.name).sort()).toEqual(['background', 'scale', 'seed']);
  });
});

describe('redactAvatarUrl', () => {
  it('keeps seed codes and every other path as they are', () => {
    expect(redactAvatarUrl(url(OCTOCAT, '?scale=4'))).toBe(url(OCTOCAT, '?scale=4'));
    expect(redactAvatarUrl('/api/v1/layouts/someone/preview.png')).toBe('/api/v1/layouts/someone/preview.png');
  });

  it('replaces anything under the avatar path that is not a seed code', () => {
    expect(redactAvatarUrl('/api/v1/avatars/someone%40example.com.png?scale=4')).toBe(
      '/api/v1/avatars/[redacted]?scale=4',
    );
    expect(redactAvatarUrl('/api/v1/avatars/px.me@example.com.png')).toBe('/api/v1/avatars/[redacted]');
    expect(redactAvatarUrl('/api/v1/avatars/octocat')).toBe('/api/v1/avatars/[redacted]');
    expect(redactAvatarUrl('/api/v1/avatars/some/one.png')).toBe('/api/v1/avatars/[redacted]');
  });
});
