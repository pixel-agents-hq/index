/**
 * The tighter rate-limit bucket for write and render-triggering routes.
 *
 * @fastify/rate-limit is registered globally in server.ts with the general
 * `config.rateLimit` bucket. Spreading this into a route's options overrides
 * just that route with the stricter `config.writeRateLimit` bucket, without a
 * second plugin registration or a `global: false` route split. #8's
 * submission endpoint and anything that triggers a render are the intended
 * callers:
 *
 *   app.post('/api/v1/layouts', writeRateLimitConfig(config), handler);
 */

import type { RouteShorthandOptions } from 'fastify';

import type { ApiConfig } from './config.js';

export function writeRateLimitConfig(config: ApiConfig): RouteShorthandOptions {
  return {
    config: {
      rateLimit: {
        max: config.writeRateLimit.max,
        timeWindow: config.writeRateLimit.windowMs,
      },
    },
  };
}

/**
 * Share fan-out is an authenticated action, so its short bucket follows the
 * account across networks and never groups a shared office/Wi-Fi by IP. The
 * auth context hook runs before @fastify/rate-limit's route pre-handler.
 */
export function shareRateLimitConfig(config: ApiConfig): RouteShorthandOptions {
  return {
    config: {
      rateLimit: {
        max: config.shareRateLimit.max,
        timeWindow: config.shareRateLimit.windowMs,
        // Auth is resolved by the app's preHandler hook. The plugin defaults
        // to onRequest, which is too early for an account-keyed bucket.
        hook: 'preHandler',
        groupId: 'layout-share',
        keyGenerator: (request) => request.user?.id ?? `anonymous:${request.ip}`,
      },
    },
  };
}
