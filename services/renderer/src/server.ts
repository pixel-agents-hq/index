/**
 * The HTTP surface: POST /render, GET /health, GET /ready.
 *
 * This service takes attacker-controlled JSON and runs a browser on it, so
 * everything here is about refusing work before it reaches Chromium: a body
 * limit, then schema and semantic validation, then a bounded queue, then a
 * timeout.
 */

import {
  createValidator,
  type Layout,
  mergeFurnitureCatalog,
  sha256,
  type UpstreamPin,
  upstreamPin,
  validateLayout,
  type ValidationIssue,
} from '@pixel-index/layout-core';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import { cacheKey, PreviewCache } from './cache.js';
import type { RendererConfig } from './config.js';
import { type RenderCustomAsset, type Renderer, RenderTimeoutError } from './render.js';

export interface BuildServerDeps {
  config: RendererConfig;
  renderer: Renderer;
  cache: PreviewCache;
}

/**
 * `GET /ready` when the browser is up. Exported so the integration suite reads
 * a checked shape rather than `any` — a typo in a field name there would
 * otherwise assert `undefined === undefined` and pass.
 */
export interface ReadyBody {
  status: 'ok';
  pixelAgents: UpstreamPin;
  inFlight: number;
  concurrency: number;
}

/** Every error this service returns. `issues` is only set for invalid_layout. */
export interface RenderErrorBody {
  error: 'invalid_scale' | 'invalid_layout' | 'render_timeout' | 'render_failed';
  message?: string;
  issues?: ValidationIssue[];
}

/** Fractions only, and only ones that land on whole pixels for pixel art. */
const ALLOWED_SCALES = new Set([1, 0.5, 0.25]);

export async function buildServer({
  config,
  renderer,
  cache,
}: BuildServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // Refuse an oversized body at the socket, before it is parsed or validated.
    bodyLimit: config.maxLayoutBytes,
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });

  // A containerised vendor/ copy has no git linkage; upstreamPin() falls back to
  // the committed stamp beside the checkout, which is what keeps the cache key
  // below pinned to a *commit* rather than degrading to the version alone — the
  // pin routinely sits several commits past a tag, so two builds of one version
  // would otherwise serve each other's cached previews.
  const pin = upstreamPin(config.upstreamDir);
  if (pin.commit === null) {
    app.log.warn(
      'Upstream commit is unknown, so the preview cache key falls back to the ' +
        'version alone. Two builds of the same version would share cached ' +
        'previews. Expected vendor/pixel-agents.commit beside the checkout — ' +
        'run: npm run vendor:commit',
    );
  }
  // Read the furniture catalog once. It walks the whole asset tree, so doing it
  // per request would dominate the cost of everything except the render itself.
  const validator = createValidator({
    ...(config.upstreamDir ? { upstreamDir: config.upstreamDir } : {}),
    upstreamVersion: pin.version,
  });

  app.get('/health', () => ({ status: 'ok' }));

  /**
   * Readiness is not liveness. A health check that always returns 200 is how a
   * container stays in a load balancer while broken, so this one asserts the
   * browser is actually connected.
   */
  app.get('/ready', async (_request, reply) => {
    if (!renderer.isRunning) {
      return reply.code(503).send({ status: 'unavailable', reason: 'browser is not running' });
    }
    return reply.send({
      status: 'ok',
      pixelAgents: pin,
      inFlight: renderer.inFlight,
      concurrency: config.concurrency,
    });
  });

  app.post('/render', async (request, reply) => {
    const body = request.body as
      | { layout?: unknown; scale?: unknown; customAssets?: RenderCustomAsset[] }
      | undefined;
    const layout = body?.layout ?? body;
    // #101 furniture, #105 characters + pets: custom assets services/api
    // embedded directly in the request — this service has no database of its
    // own to look them up in.
    const customAssets = body?.customAssets ?? [];
    // Only furniture affects layout validation — a layout's `furniture[].type`
    // is checked against the catalog, but a character is never referenced by
    // a layout at all and a pet's `petType` is never catalog-checked
    // (`packages/layout-core` treats `pets` as opaque). Extending the catalog
    // for a request with only characters/pets would be pointless work.
    const customFurniture = customAssets.filter((asset) => asset.kind === 'furniture');

    const scale = body?.scale === undefined ? 1 : Number(body.scale);
    if (!ALLOWED_SCALES.has(scale)) {
      return reply.code(400).send({
        error: 'invalid_scale',
        message: `scale must be one of ${[...ALLOWED_SCALES].join(', ')}`,
      });
    }

    // Never hand unvalidated JSON to a browser. This also means a layout the
    // index would reject can never occupy a render slot. `validator.catalog`
    // extended with this request's custom furniture, not re-read from disk —
    // see `mergeFurnitureCatalog`'s own doc comment for why that's cheap
    // enough to do unconditionally.
    const catalog =
      customFurniture.length > 0
        ? mergeFurnitureCatalog(validator.catalog, customFurniture.map((asset) => asset.catalogEntry))
        : validator.catalog;
    const { valid, issues } =
      customFurniture.length > 0
        ? validateLayout(layout, {
            catalog,
            requiredRevision: validator.requiredRevision,
            upstreamVersion: pin.version,
          })
        : validator.validateLayout(layout);
    if (!valid) {
      return reply.code(422).send({ error: 'invalid_layout', issues });
    }

    // Hash the exact bytes we were given, not a reserialisation, so the key
    // matches what #8 stores and dedupes on.
    const layoutBytes = JSON.stringify(layout);
    const key = cacheKey({
      layoutBytes,
      upstreamCommit: pin.commit,
      upstreamVersion: pin.version,
      scale,
      ...(customAssets.length > 0 ? { customAssetsBytes: JSON.stringify(customAssets) } : {}),
    });

    const cached = await cache.get(key);
    if (cached) {
      return sendPng(reply, cached, { key, cache: 'hit' });
    }

    try {
      const png = await renderer.render(layout as Layout, { scale, customAssets });
      await cache.set(key, png);
      // Awaited inside the try on purpose: an un-awaited return would let a
      // send failure escape the catch below as an unhandled rejection.
      return await sendPng(reply, png, { key, cache: 'miss' });
    } catch (error) {
      if (error instanceof RenderTimeoutError) {
        request.log.warn({ err: error }, 'render timed out');
        return reply.code(504).send({ error: 'render_timeout', message: error.message });
      }
      request.log.error({ err: error }, 'render failed');
      return reply.code(500).send({
        error: 'render_failed',
        message: error instanceof Error ? error.message : 'unknown error',
      });
    }
  });

  return app;
}

function sendPng(
  reply: FastifyReply,
  png: Buffer,
  meta: { key: string; cache: 'hit' | 'miss' },
) {
  return reply
    .header('content-type', 'image/png')
    // Content-addressed, so it is safe to cache hard and forever.
    .header('cache-control', 'public, max-age=31536000, immutable')
    .header('etag', `"${meta.key}"`)
    .header('x-render-cache', meta.cache)
    .header('x-content-sha256', sha256(png))
    .send(png);
}
