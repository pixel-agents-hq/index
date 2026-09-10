/**
 * GET / — the one thing a stranger who has never seen this project hits
 * first. A third-party integrator (the Pico Discord Bot, or anyone building
 * against this API) curling the bare API origin with no prior knowledge gets
 * a 404 today unless they already know `/docs` exists. This is the pointer:
 * where the OpenAPI docs live, where the machine-readable spec lives, which
 * commit is actually running, and where to go to build something with it.
 *
 * JSON, not HTML: a bare API origin is far more likely to be curled or
 * fetched by an integrator's tooling than opened in a browser — a human
 * exploring interactively already lands on the frontend's own domain.
 */

import type { FastifyInstance } from 'fastify';

import type { ApiConfig } from './config.js';
import { rootResponseSchema } from './layouts/schemas.js';

export const API_VERSION = '1';

export interface RootBody {
  name: string;
  description: string;
  version: string;
  commit: string | null;
  documentation: string;
  openapi: string;
  repository: string;
}

export function registerRootRoutes(app: FastifyInstance, config: ApiConfig): void {
  app.get('/', { schema: { response: rootResponseSchema } }, (): RootBody => ({
    name: 'Pixel Index API',
    description:
      'The public read API for a Pixel Index instance. Third-party integration is ' +
      'encouraged — build a bot, a browser extension, whatever you want against this ' +
      'API and open an issue or PR with the idea. See the repository link below.',
    version: API_VERSION,
    commit: config.commit ?? null,
    documentation: `${config.publicApiOrigin}/docs`,
    openapi: `${config.publicApiOrigin}/openapi.json`,
    repository: 'https://github.com/pixel-agents-hq/index',
  }));
}
