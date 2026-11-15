import { withFormats } from '@pixel-index/layout-core';
import { Ajv } from 'ajv';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, assert, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestDatabase, type Harness } from '../db/test-support/harness.js';
import type { EnvelopeBody } from '../errors.js';
import { buildServer } from '../server.js';
import { type OpenApiDoc, parseRenderRequest } from '../test-support/bodies.js';
import { testConfig } from '../test-support/config.js';
import { insertLayout, insertUser, tagLayout } from '../test-support/layouts.js';
import type { ListLayoutsBody, ListTagsBody } from './responses.js';
import {
  layoutDetailResponseSchema,
  layoutDetailSchema,
  layoutSummarySchema,
  listLayoutsResponseSchema,
  publicAuthorSchema,
} from './schemas.js';
import type { PublicLayoutDetail } from './serialize.js';

const config = testConfig();
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
afterEach(() => vi.unstubAllGlobals());

// The exact schemas Fastify uses to serialize responses — validating a real
// response against these is what makes "the OpenAPI doc matches actual
// responses" a checked fact instead of a claim. Building a bogus 2020-ish
// $schema draft here would prove nothing about what Fastify actually did.
const ajv = withFormats(new Ajv({ strict: false }));
ajv.addSchema(publicAuthorSchema);
ajv.addSchema(layoutSummarySchema);
ajv.addSchema(layoutDetailSchema);
const validateList = ajv.compile(listLayoutsResponseSchema[200]);
const validateDetail = ajv.compile(layoutDetailResponseSchema[200]);

describe('GET /api/v1/layouts', () => {
  it('lists a public layout with author and tags resolved', async () => {
    const author = await insertUser(harness.db, { username: 'route-author' });
    const layout = await insertLayout(harness.db, {
      slug: 'route-list-basic',
      authorUserId: author.id,
      title: 'Route Listed Office',
    });
    await tagLayout(harness.db, layout.id, 'route-tag');

    const response = await app.inject({ method: 'GET', url: '/api/v1/layouts?limit=100' });
    expect(response.statusCode).toBe(200);
    const body = response.json<ListLayoutsBody>();
    expect(validateList(body), JSON.stringify(validateList.errors)).toBe(true);

    const entry = body.layouts.find((l) => l.slug === 'route-list-basic');
    expect(entry?.author).toEqual({
      discordId: author.discordId,
      username: 'route-author',
      displayName: 'route-author',
      avatarUrl: null,
      avatarSeed: author.avatarSeed,
    });
    expect(entry?.tags).toEqual(['route-tag']);
    expect(entry?.files.layout).toBe('/api/v1/layouts/route-list-basic/download');
  });

  it('never lists a hidden or deleted layout', async () => {
    await insertLayout(harness.db, { slug: 'route-hidden', visibility: 'hidden' });
    await insertLayout(harness.db, { slug: 'route-deleted', visibility: 'deleted' });

    const response = await app.inject({ method: 'GET', url: '/api/v1/layouts?limit=100' });
    const slugs = response.json<ListLayoutsBody>().layouts.map((l) => l.slug);
    expect(slugs).not.toContain('route-hidden');
    expect(slugs).not.toContain('route-deleted');
  });

  it('composes filters over HTTP query params', async () => {
    const author = await insertUser(harness.db, { username: 'route-compose-author' });
    const match = await insertLayout(harness.db, {
      slug: 'route-compose-match',
      authorUserId: author.id,
      cols: 30,
      rows: 30,
    });
    await tagLayout(harness.db, match.id, 'route-compose-tag');
    await insertLayout(harness.db, { slug: 'route-compose-other-author', cols: 30, rows: 30 });
    assert(author.discordId !== null, 'insertUser did not give the author a Discord id');

    const response = await app.inject({
      method: 'GET',
      // ?author= is a Discord id (#61), not the internal UUID — the route
      // must resolve it before filtering.
      url: `/api/v1/layouts?author=${author.discordId}&tags=route-compose-tag&minCols=25`,
    });
    const slugs = response.json<ListLayoutsBody>().layouts.map((l) => l.slug);
    expect(slugs).toEqual(['route-compose-match']);
  });

  it('paginates with a stable cursor across two HTTP requests', async () => {
    const BASE = 70_000;
    for (let i = 0; i < 3; i += 1) {
      await insertLayout(harness.db, { slug: `route-page-${i}`, furnitureCount: BASE + i });
    }
    const page1 = await app.inject({
      method: 'GET',
      url: `/api/v1/layouts?sort=furniture&minFurniture=${BASE}&limit=2`,
    });
    const body1 = page1.json<ListLayoutsBody>();
    expect(body1.layouts.map((l) => l.slug)).toEqual(['route-page-2', 'route-page-1']);
    expect(body1.nextCursor).toBeTruthy();

    const page2 = await app.inject({
      method: 'GET',
      url: `/api/v1/layouts?sort=furniture&minFurniture=${BASE}&limit=2&cursor=${encodeURIComponent(body1.nextCursor ?? '')}`,
    });
    expect(page2.json<ListLayoutsBody>().layouts.map((l) => l.slug)).toEqual(['route-page-0']);
  });

  it('rejects an unknown query parameter rather than silently ignoring it', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/layouts?bogus=1' });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a limit outside the allowed range', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/layouts?limit=1000' });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/v1/layouts/:slug', () => {
  it('returns the full record, including the parsed layout', async () => {
    await insertLayout(harness.db, { slug: 'route-detail', raw: '{"version":1,"marker":"detail"}' });
    const response = await app.inject({ method: 'GET', url: '/api/v1/layouts/route-detail' });
    expect(response.statusCode).toBe(200);
    const body = response.json<PublicLayoutDetail>();
    expect(validateDetail(body), JSON.stringify(validateDetail.errors)).toBe(true);
    expect(body.layout).toEqual({ version: 1, marker: 'detail' });
  });

  it('is a 404 for an unknown slug', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/layouts/does-not-exist' });
    expect(response.statusCode).toBe(404);
  });

  it.each(['hidden', 'deleted'] as const)(
    'is a 404 for a %s layout — cannot be distinguished from a slug that never existed',
    async (visibility) => {
      await insertLayout(harness.db, { slug: `route-detail-${visibility}`, visibility });
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/layouts/route-detail-${visibility}`,
      });
      expect(response.statusCode).toBe(404);
    },
  );

  it('serves a 304 when If-None-Match matches the current sha256', async () => {
    const layout = await insertLayout(harness.db, { slug: 'route-detail-etag' });
    const first = await app.inject({ method: 'GET', url: '/api/v1/layouts/route-detail-etag' });
    expect(first.headers.etag).toBe(`"${layout.sha256}"`);

    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/layouts/route-detail-etag',
      headers: { 'if-none-match': first.headers.etag as string },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });
});

describe('GET /api/v1/layouts/:slug/download', () => {
  it('serves the raw bytes verbatim, not a re-serialised copy', async () => {
    // Deliberately unusual formatting a JSON.stringify would never reproduce.
    const raw = '{"version":  1,\n  "note":"byte-exact"}';
    await insertLayout(harness.db, { slug: 'route-download', raw, layout: JSON.parse(raw) });

    const response = await app.inject({ method: 'GET', url: '/api/v1/layouts/route-download/download' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(raw);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="route-download.json"',
    );
  });

  it('is a 404 for a hidden layout, same as detail', async () => {
    await insertLayout(harness.db, { slug: 'route-download-hidden', visibility: 'hidden' });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/layouts/route-download-hidden/download',
    });
    expect(response.statusCode).toBe(404);
  });
});

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fakeRenderer(behaviour: 'ok' | 'invalid' | 'down' = 'ok') {
  return vi.fn(async (_url: string | URL, init: RequestInit) => {
    if (behaviour === 'down') throw new Error('connection refused');
    if (behaviour === 'invalid') {
      return new Response(JSON.stringify({ issues: [{ code: 'x', path: '/', message: 'bad' }] }), {
        status: 422,
      });
    }
    const body = JSON.parse(init.body as string) as { scale: number };
    return new Response(PNG_MAGIC, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        etag: `"fake-${body.scale}"`,
        'x-render-cache': 'miss',
      },
    });
  });
}

describe('GET /api/v1/layouts/:slug/preview.png', () => {
  it('proxies the renderer with scale 1 and forwards its etag', async () => {
    const fetchSpy = fakeRenderer('ok');
    vi.stubGlobal('fetch', fetchSpy);
    await insertLayout(harness.db, { slug: 'route-preview' });

    const response = await app.inject({ method: 'GET', url: '/api/v1/layouts/route-preview/preview.png' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.rawPayload.subarray(0, 8)).toEqual(PNG_MAGIC);
    expect(response.headers.etag).toBe('"fake-1"');

    const firstCall = fetchSpy.mock.calls[0];
    assert(firstCall, 'the renderer was never called');
    expect(parseRenderRequest(firstCall[1]).scale).toBe(1);
  });

  it('is a 404 for a hidden layout and never calls the renderer at all', async () => {
    const fetchSpy = fakeRenderer('ok');
    vi.stubGlobal('fetch', fetchSpy);
    await insertLayout(harness.db, { slug: 'route-preview-hidden', visibility: 'hidden' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/layouts/route-preview-hidden/preview.png',
    });
    expect(response.statusCode).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is a 502 when the renderer is unreachable', async () => {
    vi.stubGlobal('fetch', fakeRenderer('down'));
    await insertLayout(harness.db, { slug: 'route-preview-down' });
    const response = await app.inject({ method: 'GET', url: '/api/v1/layouts/route-preview-down/preview.png' });
    expect(response.statusCode).toBe(502);
    expect(response.json<EnvelopeBody>().error).toBe('renderer_unavailable');
  });

  it('is a 500, not a client error, when a stored layout fails the renderer\'s own validation', async () => {
    // A stored layout rejected by validation is this service's bug, not the
    // caller's — nothing about the request was wrong.
    vi.stubGlobal('fetch', fakeRenderer('invalid'));
    await insertLayout(harness.db, { slug: 'route-preview-invalid' });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/layouts/route-preview-invalid/preview.png',
    });
    expect(response.statusCode).toBe(500);
  });

  it('serves a 304 when If-None-Match matches the renderer-provided etag', async () => {
    vi.stubGlobal('fetch', fakeRenderer('ok'));
    await insertLayout(harness.db, { slug: 'route-preview-etag' });
    const first = await app.inject({ method: 'GET', url: '/api/v1/layouts/route-preview-etag/preview.png' });
    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/layouts/route-preview-etag/preview.png',
      headers: { 'if-none-match': first.headers.etag as string },
    });
    expect(second.statusCode).toBe(304);
  });
});

describe('GET /api/v1/layouts/:slug/thumbnail.png', () => {
  it('requests scale 1 from the renderer, same as preview.png', async () => {
    // Not a separately rendered 0.25-scale PNG: pre-shrinking server-side and
    // then letting the gallery grid's CSS scale that already-shrunk bitmap
    // again to fit a responsive card width measurably threw away real pixel
    // information a single direct scale from the full render would have kept.
    // `image-rendering: pixelated` (apps/web) does the one and only resize now.
    const fetchSpy = fakeRenderer('ok');
    vi.stubGlobal('fetch', fetchSpy);
    await insertLayout(harness.db, { slug: 'route-thumbnail' });

    await app.inject({ method: 'GET', url: '/api/v1/layouts/route-thumbnail/thumbnail.png' });
    const firstCall = fetchSpy.mock.calls[0];
    assert(firstCall, 'the renderer was never called');
    expect(parseRenderRequest(firstCall[1]).scale).toBe(1);
  });
});

describe('GET /api/v1/tags', () => {
  it('returns only tags used by a public layout, most-used first', async () => {
    const popular = await insertLayout(harness.db, { slug: 'tags-popular', visibility: 'public' });
    const rare = await insertLayout(harness.db, { slug: 'tags-rare', visibility: 'public' });
    const hidden = await insertLayout(harness.db, { slug: 'tags-hidden-owner', visibility: 'hidden' });
    await tagLayout(harness.db, popular.id, 'cosy');
    await tagLayout(harness.db, rare.id, 'cosy');
    await tagLayout(harness.db, rare.id, 'minimal');
    // A tag used only by a non-public layout must not appear at all — #14's
    // multi-select would otherwise offer a filter guaranteed to return zero
    // public results.
    await tagLayout(harness.db, hidden.id, 'hidden-only');

    const response = await app.inject({ method: 'GET', url: '/api/v1/tags' });
    expect(response.statusCode).toBe(200);
    const body = response.json<ListTagsBody>();
    // Shared harness across this file's tests, so other tests' tags may
    // also be present — assert on the ones this test controls.
    expect(body.tags).toEqual(expect.arrayContaining([{ name: 'cosy', count: 2 }, { name: 'minimal', count: 1 }]));
    expect(body.tags.find((t) => t.name === 'hidden-only')).toBeUndefined();
    // Popularity order holds even amid other tests' tags: cosy (2) sorts
    // ahead of minimal (1).
    const names = body.tags.map((t) => `${t.name}:${t.count}`);
    expect(names.indexOf('cosy:2')).toBeLessThan(names.indexOf('minimal:1'));
  });

});

describe('OpenAPI document', () => {
  it('is served and describes the layout routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    const doc = response.json<OpenApiDoc>();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths['/api/v1/layouts']).toBeDefined();
    expect(doc.paths['/api/v1/layouts/{slug}']).toBeDefined();
    expect(doc.paths['/api/v1/meta']).toBeDefined();
    expect(doc.components.schemas.LayoutSummary).toBeDefined();
    expect(doc.components.schemas.LayoutDetail).toBeDefined();
    // Internal ops endpoints are deliberately not part of the public contract.
    expect(doc.paths['/health']).toBeUndefined();
    expect(doc.paths['/ready']).toBeUndefined();
  });

  it('the docs UI is reachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs' });
    expect(response.statusCode).toBeLessThan(400);
  });
});
