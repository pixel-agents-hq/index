/**
 * The API service skeleton: CORS, error envelope, rate limiting, health and
 * readiness — plus, as of #6/#7, the public layout API and Discord auth.
 *
 * The frontend is on GitHub Pages and this service is on another origin, so
 * every browser call is cross-origin. CORS is therefore a product surface,
 * not a detail: the allowlist comes from config, so the official index and a
 * self-hoster's Pages domain are both just values, and nothing but an
 * allowlisted origin can carry credentials.
 */

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerAuthContext } from './auth/context.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerAuthorRoutes } from './authors/routes.js';
import { registerBackupExportRoutes } from './backup/export.js';
import { registerBackupImportRoutes } from './backup/import.js';
import { allowsWebOrigin, type ApiConfig } from './config.js';
import type { AnyDatabase } from './db/client.js';
import type { Queryable } from './db/pool.js';
import { registerErrorHandling } from './errors.js';
import { registerExportRoutes } from './layouts/export.js';
import { registerManageRoutes } from './layouts/manage.js';
import { registerLayoutRoutes } from './layouts/routes.js';
import { sharedSchemas } from './layouts/schemas.js';
import { registerShareRoutes } from './layouts/share.js';
import { registerSubmitRoutes } from './layouts/submit.js';
import { buildUpstreamValidator } from './layouts/upstreamValidator.js';
import { registerMetaRoutes } from './meta.js';
import { registerAuditRoutes } from './moderation/auditRoutes.js';
import { registerModerationRoutes } from './moderation/routes.js';
import { API_VERSION, registerRootRoutes } from './root.js';
import { registerUserAdminRoutes } from './users/routes.js';
import { WebhookDeliveryWorker } from './webhooks/delivery.js';
import { registerWebhookSubscriptionRoutes } from './webhooks/routes.js';

export interface BuildServerDeps {
  config: ApiConfig;
  /**
   * Only `query` is required, so tests can inject a stub without a real
   * Postgres. The real pool is created in index.ts and outlives the app —
   * see the note on `onClose` there.
   */
  pool: Queryable;
  /** The full Drizzle handle, for the auth routes and everything after. */
  db: AnyDatabase;
  /** Injectable only so delivery tests never make a real network request. */
  webhookFetch?: typeof fetch;
}

/**
 * The request-validation options every route's schema is compiled with.
 *
 * Fastify's ajv default is `removeAdditional: true`, which SILENTLY STRIPS
 * unrecognised query/body properties even when a schema declares
 * `additionalProperties: false` — "no error" is the ajv default whenever both
 * options are set. For a filtering API that is the worst failure mode:
 * `?minCols=…` typo'd as `?mincols=…` would be dropped rather than rejected,
 * and the caller gets a silently-unfiltered result they never asked for
 * instead of a 400 telling them what they got wrong.
 *
 * Exported because route handlers now rely on ajv's *other* default,
 * `useDefaults`, to apply `default:` from the schema — the reason they no
 * longer carry `?? 24` fallbacks. schemas.test.ts pins that against this exact
 * object rather than a copy of it.
 */
export const AJV_OPTIONS = { customOptions: { removeAdditional: false } };

export async function buildServer({ config, pool, db, webhookFetch }: BuildServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: config.bodyLimitBytes,
    // The reverse proxy (Traefik, Cloudflare Tunnel) sets X-Forwarded-For.
    // Without this, every client shares the proxy's IP and one bucket.
    trustProxy: config.trustProxy,
    logger: { level: config.logLevel },
    ajv: AJV_OPTIONS,
  });

  registerErrorHandling(app);
  registerAuthContext(app, config.sessionSecret);

  await app.register(cookie);

  await app.register(cors, {
    // No `origin` header (curl, server-to-server, same-origin) is not a CORS
    // request at all — nothing to check. A browser always sends one.
    origin: (origin, callback) => {
      callback(null, origin === undefined || allowsWebOrigin(config, origin));
    },
    credentials: true,
    // Without this, @fastify/cors derives the preflight's Allow-Methods
    // header from whatever routes happen to be registered on the exact
    // request path at the time the OPTIONS handler was created — found live
    // (#15) as a real bug: `PATCH /api/v1/layouts/:slug` (manage.ts) was
    // silently rejected by the browser's preflight because the derived list
    // only ever included GET/HEAD/POST. Every method any route in this API
    // actually uses, spelled out, so the preflight response never depends on
    // registration order or which plugin happened to register first.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.windowMs,
    // Keyed on the real client via trustProxy above, not the reverse proxy.
    //
    // @fastify/rate-limit *throws* whatever this returns into Fastify's normal
    // error pipeline (it does not reply.send() directly) — so the returned
    // value has to be an Error with `.statusCode` set, exactly like its own
    // default builder, or the central error handler in errors.ts has no
    // status to key on and falls back to 500. registerErrorHandling() renders
    // the actual envelope; this only has to get the shape right.
    errorResponseBuilder: (_request, context) => {
      const error = new Error(
        `Too many requests. Retry in ${Math.ceil(context.ttl / 1000)}s.`,
      ) as Error & { statusCode: number };
      error.statusCode = context.statusCode;
      return error;
    },
  });

  // Registered before the routes it documents: @fastify/swagger captures
  // schemas as routes register via an onRoute hook, and this way every route
  // below is captured regardless of registration order mattering elsewhere.
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Pixel Index API',
        version: API_VERSION,
        description:
          'The public read API for a Pixel Index instance. No authentication required — ' +
          'reading is public. See /api/v1/meta for the pinned Pixel Agents version.',
      },
      servers: [{ url: config.publicApiOrigin }],
    },
    // Default naming for a $ref'd shared schema is the meaningless "def-0",
    // "def-1", … — using the schema's own $id (PublicAuthor, LayoutSummary, …)
    // is what makes `components.schemas.LayoutSummary` findable by name
    // rather than by registration order.
    refResolver: {
      buildLocalReference: (json) => (json.$id as string | undefined) ?? 'def',
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());

  for (const schema of sharedSchemas) app.addSchema(schema);

  // Built once, shared by every route that needs to validate a layout against
  // the pinned upstream (submit's POST, manage's PUT .../layout) — see
  // upstreamValidator.ts for why this never throws.
  const upstream = buildUpstreamValidator(config, app.log, 'layout submission and editing');
  const deliveryWorker = new WebhookDeliveryWorker(db, config, app.log, {
    ...(webhookFetch ? { fetchImpl: webhookFetch } : {}),
  });
  app.addHook('onListen', () => {
    deliveryWorker.start();
  });
  app.addHook('onClose', () => {
    deliveryWorker.stop();
  });

  registerRootRoutes(app, config);
  registerAuthRoutes(app, { config, db });
  registerAuthorRoutes(app, { db });
  registerMetaRoutes(app, config, db);
  registerLayoutRoutes(app, { config, db });
  registerShareRoutes(app, { config, db, upstream, deliveryWorker });
  registerExportRoutes(app, { config, db });
  registerSubmitRoutes(app, { config, db, upstream });
  registerManageRoutes(app, { config, db, upstream });
  registerUserAdminRoutes(app, { config, db });
  registerModerationRoutes(app, { config, db });
  registerAuditRoutes(app, { config, db });
  registerBackupExportRoutes(app, { config, db });
  registerBackupImportRoutes(app, { config, db, upstream });
  registerWebhookSubscriptionRoutes(app, { config, db });

  app.get('/health', { schema: { hide: true } }, () => ({ status: 'ok' }));

  /**
   * Readiness is not liveness. A health check that always returns 200 is how
   * a container stays in a load balancer while broken — this one actually
   * reaches Postgres. Bound to a short timeout so a hanging database makes
   * this fail fast rather than pile up requests.
   */
  app.get('/ready', { schema: { hide: true } }, async (request, reply) => {
    try {
      await withTimeout(pool.query('SELECT 1'), 2000);
    } catch (error) {
      request.log.warn({ err: error }, 'readiness check failed');
      return reply.code(503).send({ status: 'unavailable', reason: 'database unreachable' });
    }
    return { status: 'ok' };
  });

  return app;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref();
    }),
  ]);
}
