import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signAccessToken } from '../auth/tokens.js';
import * as schema from '../db/schema.js';
import { createTestDatabase, type Harness } from '../db/test-support/harness.js';
import { buildServer } from '../server.js';
import { testConfig } from '../test-support/config.js';
import { insertUser } from '../test-support/layouts.js';
import type {
  CreatedWebhookSubscriptionBody,
  ListWebhookSubscriptionsBody,
  WebhookSubscriptionView,
} from './routes.js';

const config = testConfig({
  discordGuild: {
    id: '1478428628709802166',
    inviteUrl: 'https://discord.gg/example',
    moderatorRoleIds: ['1528065925264445622'],
    oauthTokenEncryptionKey: Buffer.alloc(32, 2).toString('base64'),
  },
  shareRateLimit: { max: 100, windowMs: 60_000 },
});
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

async function tokenFor(role: 'user' | 'moderator' | 'admin') {
  const user = await insertUser(harness.db, {
    role,
    discordGuildMember: true,
    discordMembershipCheckedAt: new Date(),
  });
  if (role === 'admin' && user.discordId) config.discordAdminIds.push(user.discordId);
  const token = await signAccessToken({ sub: user.id }, config.sessionSecret, 60_000);
  return { user, token };
}

function createSubscription(token: string | undefined, name: string, endpointUrl = 'https://pico.example/webhooks') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/moderation/webhook-subscriptions',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { name, endpointUrl },
  });
}

describe('webhook subscription management', () => {
  it('is moderator-only, creates a server secret, and never stores or lists it in plaintext', async () => {
    const { token: userToken } = await tokenFor('user');
    expect((await createSubscription(undefined, 'anonymous-service')).statusCode).toBe(401);
    expect((await createSubscription(userToken, 'user-service')).statusCode).toBe(403);

    const { user: moderator, token } = await tokenFor('moderator');
    const response = await createSubscription(token, 'Pico');
    expect(response.statusCode).toBe(201);
    const created = response.json<CreatedWebhookSubscriptionBody>();
    expect(created.secret).toMatch(/^whsec_/);
    expect(created.subscription).toMatchObject({
      name: 'Pico',
      endpointUrl: 'https://pico.example/webhooks',
      active: true,
      createdBy: { discordId: moderator.discordId, username: moderator.username },
    });
    expect(created.subscription.secretHint).toBe(created.secret.slice(-4));

    const [stored] = await harness.db
      .select()
      .from(schema.webhookSubscriptions)
      .where(eq(schema.webhookSubscriptions.id, created.subscription.id));
    expect(stored?.encryptedSecret).not.toContain(created.secret);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/moderation/webhook-subscriptions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json<ListWebhookSubscriptionsBody>();
    expect(body.subscriptions.map((entry) => entry.name)).toContain('Pico');
    expect(JSON.stringify(body)).not.toContain(created.secret);
    expect(JSON.stringify(body)).not.toContain('encryptedSecret');
  });

  it('requires an HTTPS endpoint without embedded credentials and unique service names', async () => {
    const { token } = await tokenFor('moderator');
    expect((await createSubscription(token, 'cleartext', 'http://pico.example/hook')).statusCode).toBe(400);
    expect((await createSubscription(token, 'credentialed', 'https://me:secret@pico.example/hook')).statusCode).toBe(400);
    expect((await createSubscription(token, '   ')).statusCode).toBe(400);
    expect((await createSubscription(token, 'unique-name')).statusCode).toBe(201);
    expect((await createSubscription(token, 'unique-name')).statusCode).toBe(409);
  });

  it('shows a moderator only their own subscriptions while an admin sees every creator', async () => {
    const first = await tokenFor('moderator');
    const second = await tokenFor('moderator');
    const admin = await tokenFor('admin');
    await createSubscription(first.token, `first-${first.user.id}`);
    await createSubscription(second.token, `second-${second.user.id}`);

    const firstList = await app.inject({
      method: 'GET',
      url: '/api/v1/moderation/webhook-subscriptions',
      headers: { authorization: `Bearer ${first.token}` },
    });
    const firstCreators = firstList
      .json<ListWebhookSubscriptionsBody>()
      .subscriptions.map((entry) => entry.createdBy.discordId);
    expect(new Set(firstCreators)).toEqual(new Set([first.user.discordId]));

    const adminList = await app.inject({
      method: 'GET',
      url: '/api/v1/moderation/webhook-subscriptions',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    const adminCreators = adminList
      .json<ListWebhookSubscriptionsBody>()
      .subscriptions.map((entry) => entry.createdBy.discordId);
    expect(adminCreators).toEqual(expect.arrayContaining([first.user.discordId, second.user.discordId]));
  });

  it('returns a rotated secret once and lets only admins deactivate delivery', async () => {
    const moderator = await tokenFor('moderator');
    const other = await tokenFor('moderator');
    const admin = await tokenFor('admin');
    const createdResponse = await createSubscription(moderator.token, `rotate-${moderator.user.id}`);
    const created = createdResponse.json<CreatedWebhookSubscriptionBody>();

    const forbiddenRotate = await app.inject({
      method: 'POST',
      url: `/api/v1/moderation/webhook-subscriptions/${created.subscription.id}/rotate`,
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(forbiddenRotate.statusCode).toBe(403);

    const rotatedResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/moderation/webhook-subscriptions/${created.subscription.id}/rotate`,
      headers: { authorization: `Bearer ${moderator.token}` },
    });
    expect(rotatedResponse.statusCode).toBe(200);
    const rotated = rotatedResponse.json<CreatedWebhookSubscriptionBody>();
    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.subscription.secretRotatedAt).not.toBeNull();

    const forbiddenPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/webhook-subscriptions/${created.subscription.id}`,
      headers: { authorization: `Bearer ${moderator.token}` },
      payload: { active: false },
    });
    expect(forbiddenPatch.statusCode).toBe(403);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/webhook-subscriptions/${created.subscription.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { active: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<WebhookSubscriptionView>().active).toBe(false);
  });
});
