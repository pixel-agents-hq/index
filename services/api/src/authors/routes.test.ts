import type { FastifyInstance } from 'fastify';
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type Harness } from '../db/test-support/harness.js';
import { buildServer } from '../server.js';
import { testConfig } from '../test-support/config.js';
import { insertLayout, insertUser } from '../test-support/layouts.js';

let harness: Harness;
let app: FastifyInstance;
beforeAll(async () => {
  harness = await createTestDatabase();
  app = await buildServer({
    config: testConfig(),
    db: harness.db,
    pool: { query: async () => ({ rows: [] }) },
  });
});
afterAll(async () => {
  await app.close();
  await harness.close();
});

describe('GET /api/v1/authors/:id', () => {
  it('is looked up by Discord id and returns public profile data with the Discord id, not the internal UUID (#61)', async () => {
    const author = await insertUser(harness.db, {
      discordId: 'discord-snowflake-1',
      username: 'discord-handle',
      globalName: 'Global Name',
      guildNickname: 'Guild Nick',
      avatarUrl: 'https://cdn.discordapp.com/avatar.png',
    });
    await insertLayout(harness.db, { authorUserId: author.id, visibility: 'public' });
    await insertLayout(harness.db, { authorUserId: author.id, visibility: 'hidden' });
    assert(author.discordId !== null, 'insertUser did not give the author a Discord id');
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/authors/${author.discordId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemaVersion: 1,
      author: {
        discordId: author.discordId,
        username: 'discord-handle',
        displayName: 'Guild Nick',
        avatarUrl: 'https://cdn.discordapp.com/avatar.png',
        avatarSeed: author.avatarSeed,
      },
      publicLayoutCount: 1,
    });
    // The internal UUID must never appear in a public author response.
    expect(response.body).not.toContain(author.id);
    expect(response.body).not.toContain('role');
  });

  it('gives an author without a picture a stored default avatar the avatar route draws (#133)', async () => {
    const author = await insertUser(harness.db, { username: 'no-picture', avatarUrl: null });
    await insertLayout(harness.db, { authorUserId: author.id, visibility: 'public' });
    const response = await app.inject({ method: 'GET', url: `/api/v1/authors/${author.discordId ?? ''}` });
    const { avatarUrl, avatarSeed } = response.json<{ author: { avatarUrl: null; avatarSeed: string } }>().author;
    expect(avatarUrl).toBeNull();
    expect(avatarSeed).toBe(author.avatarSeed);
    expect(avatarSeed).toMatch(/^px\.[A-Za-z0-9_-]+$/);
    expect(avatarSeed).not.toContain('no-picture');

    const avatar = await app.inject({ method: 'GET', url: `/api/v1/avatars/${avatarSeed}.png` });
    expect(avatar.statusCode).toBe(200);
    expect(avatar.headers['content-type']).toBe('image/png');
  });

  it('404s for the internal UUID — the public route no longer accepts it', async () => {
    const author = await insertUser(harness.db);
    await insertLayout(harness.db, { authorUserId: author.id, visibility: 'public' });
    const response = await app.inject({ method: 'GET', url: `/api/v1/authors/${author.id}` });
    expect(response.statusCode).toBe(404);
  });

  it('does not expose users with no public layouts or the synthetic system user', async () => {
    const privateAuthor = await insertUser(harness.db);
    await insertLayout(harness.db, { authorUserId: privateAuthor.id, visibility: 'deleted' });
    assert(privateAuthor.discordId !== null, 'insertUser did not give the author a Discord id');
    const privateResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/authors/${privateAuthor.discordId}`,
    });
    const system = await insertUser(harness.db, { discordId: null, isSystem: true });
    await insertLayout(harness.db, { authorUserId: system.id, visibility: 'public' });
    // The system user has no discordId, so there is no valid id to look it up by.
    const systemResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/authors/${system.id}`,
    });
    expect(privateResponse.statusCode).toBe(404);
    expect(systemResponse.statusCode).toBe(404);
  });
});
