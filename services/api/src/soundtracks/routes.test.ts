import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signAccessToken } from '../auth/tokens.js';
import * as schema from '../db/schema.js';
import { createTestDatabase, type Harness } from '../db/test-support/harness.js';
import { buildServer } from '../server.js';
import { testConfig } from '../test-support/config.js';
import { insertUser } from '../test-support/layouts.js';
import type { PublicSoundtrack } from './routes.js';

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

async function tokenFor(overrides: Parameters<typeof insertUser>[1] = {}) {
  const user = await insertUser(harness.db, overrides);
  const accessToken = await signAccessToken({ sub: user.id, role: user.role }, config.sessionSecret, config.accessTokenTtlMs);
  return { user, accessToken };
}

function publish(accessToken: string | null, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/soundtracks',
    payload,
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
}

describe('POST /api/v1/soundtracks', () => {
  it('is impossible anonymously', async () => {
    const response = await publish(null, { code: 'TOWN-5-8F3A21C0' });
    expect(response.statusCode).toBe(401);
  });

  it('publishes a song code, canonicalised, with an optional title, and audits it', async () => {
    const { user, accessToken } = await tokenFor({ username: 'dj' });
    const response = await publish(accessToken, { code: ' town-5-8f3a21c0 ', title: '  Morning standup  ' });
    expect(response.statusCode).toBe(201);
    const body = response.json<PublicSoundtrack>();
    expect(body).toMatchObject({ code: 'TOWN-5-8F3A21C0', mood: 'town', title: 'Morning standup' });
    expect(body.author.username).toBe(user.username);
    expect(response.headers.location).toBe(`/api/v1/soundtracks/${body.id}`);

    const audit = await harness.db
      .select()
      .from(schema.moderationActions)
      .where(eq(schema.moderationActions.targetId, body.id));
    expect(audit.map((row) => row.action)).toEqual(['soundtrack.create']);
  });

  it('refuses a code the radio would not play', async () => {
    const { accessToken } = await tokenFor();
    for (const code of ['JAZZ-1-00000000', 'TOWN-9-00000000', 'not a code']) {
      const response = await publish(accessToken, { code });
      expect(response.statusCode, code).toBe(422);
    }
  });

  it('publishes a tune once per publisher, but two publishers can showcase the same one', async () => {
    const first = await tokenFor();
    expect((await publish(first.accessToken, { code: 'RAIN-2-0000ABCD' })).statusCode).toBe(201);
    expect((await publish(first.accessToken, { code: 'rain-2-abcd' })).statusCode).toBe(409);
    const second = await tokenFor();
    expect((await publish(second.accessToken, { code: 'RAIN-2-0000ABCD' })).statusCode).toBe(201);
  });
});

describe('GET /api/v1/soundtracks', () => {
  it('lists newest first, filters by mood and author, and pages with a cursor', async () => {
    const { user, accessToken } = await tokenFor({ username: 'lister' });
    const author = user.discordId ?? '';
    for (const code of ['ARCADE-1-00000001', 'ARCADE-1-00000002', 'DAWN-3-00000003']) {
      expect((await publish(accessToken, { code })).statusCode).toBe(201);
    }

    const byAuthor = await app.inject({ method: 'GET', url: `/api/v1/soundtracks?author=${author}` });
    const listed = byAuthor.json<{ total: number; soundtracks: PublicSoundtrack[] }>();
    expect(listed.total).toBe(3);
    expect(listed.soundtracks.map((s) => s.code)).toEqual(['DAWN-3-00000003', 'ARCADE-1-00000002', 'ARCADE-1-00000001']);

    const arcade = await app.inject({ method: 'GET', url: `/api/v1/soundtracks?author=${author}&mood=arcade` });
    expect(arcade.json<{ total: number }>().total).toBe(2);

    const first = await app.inject({ method: 'GET', url: `/api/v1/soundtracks?author=${author}&limit=2` });
    const page1 = first.json<{ soundtracks: PublicSoundtrack[]; nextCursor: string | null }>();
    expect(page1.soundtracks).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/soundtracks?author=${author}&limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
    });
    const page2 = second.json<{ soundtracks: PublicSoundtrack[]; nextCursor: string | null }>();
    expect(page2.soundtracks.map((s) => s.code)).toEqual(['ARCADE-1-00000001']);
    expect(page2.nextCursor).toBeNull();
  });

  it('gives an unknown author an empty list', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/soundtracks?author=99999999999999999' });
    expect(response.json<{ total: number }>().total).toBe(0);
  });
});

describe('DELETE /api/v1/soundtracks/:id', () => {
  async function published() {
    const owner = await tokenFor();
    const response = await publish(owner.accessToken, { code: 'ORBIT-4-DEADBEEF' });
    return { owner, id: response.json<PublicSoundtrack>().id };
  }

  it('lets the owner delete without a reason; it is gone from reads and free to publish again', async () => {
    const { owner, id } = await published();
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/soundtracks/${id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(response.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/v1/soundtracks/${id}` })).statusCode).toBe(404);
    expect((await publish(owner.accessToken, { code: 'ORBIT-4-DEADBEEF' })).statusCode).toBe(201);
  });

  it('forbids anyone else, and asks a moderator for a reason', async () => {
    const { id } = await published();
    const stranger = await tokenFor();
    const forbidden = await app.inject({
      method: 'DELETE',
      url: `/api/v1/soundtracks/${id}`,
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const moderator = await tokenFor({ role: 'moderator' });
    const noReason = await app.inject({
      method: 'DELETE',
      url: `/api/v1/soundtracks/${id}`,
      headers: { authorization: `Bearer ${moderator.accessToken}` },
    });
    expect(noReason.statusCode).toBe(400);
    const withReason = await app.inject({
      method: 'DELETE',
      url: `/api/v1/soundtracks/${id}`,
      payload: { reason: 'spam' },
      headers: { authorization: `Bearer ${moderator.accessToken}` },
    });
    expect(withReason.statusCode).toBe(204);
  });
});
