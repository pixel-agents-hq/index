import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type Harness } from './db/test-support/harness.js';
import type { RootBody } from './root.js';
import { buildServer } from './server.js';
import { testConfig } from './test-support/config.js';

const fakePool = { query: async () => ({ rows: [] }) };

let harness: Harness;
let app: FastifyInstance;
beforeAll(async () => {
  harness = await createTestDatabase();
  app = await buildServer({ config: testConfig(), pool: fakePool, db: harness.db });
});
afterAll(async () => {
  await app.close();
  await harness.close();
});

describe('GET /', () => {
  it('points a third-party integrator at the docs and the machine-readable spec', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    const body = response.json<RootBody>();
    expect(body.name).toBe('Pixel Index API');
    expect(body.documentation).toBe(`${testConfig().publicApiOrigin}/docs`);
    expect(body.openapi).toBe(`${testConfig().publicApiOrigin}/openapi.json`);
    expect(body.repository).toBe('https://github.com/pixel-agents-hq/index');
  });

  it('reports no commit when the build did not pass one', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.json<RootBody>().commit).toBeNull();
  });

  it('reports the commit baked in at build time', async () => {
    const stamped = await buildServer({
      config: testConfig({ commit: 'a'.repeat(40) }),
      pool: fakePool,
      db: harness.db,
    });
    try {
      const response = await stamped.inject({ method: 'GET', url: '/' });
      expect(response.json<RootBody>().commit).toBe('a'.repeat(40));
    } finally {
      await stamped.close();
    }
  });
});
