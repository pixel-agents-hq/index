import { bundledLayoutRevision, type Layout, sha256 } from '@pixel-index/layout-core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { signAccessToken } from '../auth/tokens.js';
import * as schema from '../db/schema.js';
import { createTestDatabase, type Harness } from '../db/test-support/harness.js';
import { buildServer } from '../server.js';
import { testConfig } from '../test-support/config.js';
import { insertLayout, insertUser } from '../test-support/layouts.js';
import type { ShareEventV1 } from '../webhooks/schema.js';
import { encryptWebhookSecret, webhookSecretHint } from '../webhooks/secret.js';
import { signWebhookBody } from '../webhooks/signature.js';
import type { ShareAcceptedBody } from './share.js';

const config = testConfig({
  shareRateLimit: { max: 100, windowMs: 60_000 },
  maxSharesPerUserPerDay: 5,
});
const fakePool = { query: async () => ({ rows: [] }) };
const layout: Layout = {
  version: 1,
  layoutRevision: bundledLayoutRevision(),
  cols: 2,
  rows: 2,
  tiles: [0, 0, 0, 0],
  furniture: [],
};

interface CapturedDelivery {
  url: string;
  init: RequestInit;
}

const deliveries: CapturedDelivery[] = [];
const webhookFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  deliveries.push({ url, init: init ?? {} });
  return new Response(null, { status: 204 });
}) as typeof fetch;

let harness: Harness;
let app: FastifyInstance;
let discordSequence = 1528094749993599038n;
function nextDiscordId(): string {
  discordSequence += 1n;
  return discordSequence.toString();
}
beforeAll(async () => {
  harness = await createTestDatabase();
  app = await buildServer({ config, pool: fakePool, db: harness.db, webhookFetch });
});
afterAll(async () => {
  await app.close();
  await harness.close();
});

async function tokenFor() {
  const user = await insertUser(harness.db, { discordId: nextDiscordId() });
  const token = await signAccessToken({ sub: user.id }, config.sessionSecret, 60_000);
  return { user, token };
}

function share(token: string | undefined, payload: object, target = app) {
  return target.inject({
    method: 'POST',
    url: '/api/v1/layouts/share',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload,
  });
}

async function activeSubscription(secret: string) {
  const creator = await insertUser(harness.db, { discordId: nextDiscordId() });
  const [subscription] = await harness.db
    .insert(schema.webhookSubscriptions)
    .values({
      name: `subscriber-${Math.random()}`,
      endpointUrl: 'https://pico.example/pixel-index',
      encryptedSecret: encryptWebhookSecret(secret, config.webhookSecretEncryptionKey),
      secretHint: webhookSecretHint(secret),
      createdByUserId: creator.id,
      createdByDiscordId: creator.discordId ?? '1528094749993599038',
      createdByUsername: creator.username,
    })
    .returning();
  if (!subscription) throw new Error('subscription fixture insert failed');
  return subscription;
}

describe('POST /api/v1/layouts/share', () => {
  it('requires authentication', async () => {
    expect((await share(undefined, { layout })).statusCode).toBe(401);
  });

  it('snapshots a published layout, its server-resolved owner, and queues every active subscriber', async () => {
    const owner = await insertUser(harness.db, {
      discordId: nextDiscordId(),
      username: 'layout-owner',
      globalName: 'Layout Owner',
    });
    const sharer = await tokenFor();
    const raw = JSON.stringify(layout);
    const published = await insertLayout(harness.db, {
      slug: `shared-${Math.random().toString(36).slice(2)}`,
      authorUserId: owner.id,
      raw,
      layout,
      sha256: sha256(raw),
      cols: layout.cols,
      rows: layout.rows,
      layoutRevision: layout.layoutRevision,
    });
    const secret = 'whsec_delivery-test-secret';
    const subscription = await activeSubscription(secret);
    const before = deliveries.length;

    const response = await share(sharer.token, { slug: published.slug });
    expect(response.statusCode).toBe(202);
    const accepted = response.json<ShareAcceptedBody>();
    expect(accepted.deliveriesQueued).toBeGreaterThanOrEqual(1);
    expect(accepted.eventId).toMatch(/^[0-9a-f-]{36}$/);

    await vi.waitFor(() => expect(deliveries.length).toBeGreaterThan(before));
    const sent = deliveries.slice(before).find((entry) => entry.url === subscription.endpointUrl);
    expect(sent).toBeDefined();
    const rawBody = sent?.init.body;
    if (typeof rawBody !== 'string') throw new Error('delivery body was not a string');
    const body = rawBody;
    const event = JSON.parse(body) as ShareEventV1;
    expect(event).toMatchObject({
      eventId: accepted.eventId,
      eventType: 'layout.shared',
      schemaVersion: 1,
      subscriptionId: subscription.id,
      data: {
        sharerDiscordId: sharer.user.discordId,
        owner: {
          discordId: owner.discordId,
          username: 'layout-owner',
          displayName: 'Layout Owner',
        },
        layout,
        publication: {
          published: true,
          url: `${config.publicApiOrigin}/api/v1/layouts/${published.slug}`,
        },
      },
    });
    const headers = new Headers(sent?.init.headers);
    const timestamp = headers.get('x-pixel-index-timestamp');
    expect(timestamp).toMatch(/^\d+$/);
    expect(headers.get('x-pixel-index-event-id')).toBe(event.eventId);
    expect(headers.get('x-pixel-index-signature')).toBe(
      signWebhookBody(secret, timestamp ?? '', body),
    );
  });

  it('accepts an unpublished inline layout with the sharer as owner and no URL field', async () => {
    const sharer = await tokenFor();
    const response = await share(sharer.token, { layout });
    expect(response.statusCode).toBe(202);
    const accepted = response.json<ShareAcceptedBody>();
    const [stored] = await harness.db
      .select()
      .from(schema.shareEvents)
      .where(eq(schema.shareEvents.id, accepted.eventId));
    const data = stored?.data as ShareEventV1['data'];
    expect(data.owner.discordId).toBe(sharer.user.discordId);
    expect(data.publication).toEqual({ published: false });
    expect('url' in data.publication).toBe(false);
  });

  it('validates inline layouts with layout-core before accepting an event', async () => {
    const sharer = await tokenFor();
    const response = await share(sharer.token, { layout: { ...layout, version: 2 } });
    expect(response.statusCode).toBe(422);
  });

  it('enforces the rolling daily limit from persisted accepted events', async () => {
    const sharer = await tokenFor();
    for (let index = 0; index < config.maxSharesPerUserPerDay; index += 1) {
      await harness.db.insert(schema.shareEvents).values({
        sharerUserId: sharer.user.id,
        data: {},
        occurredAt: new Date(),
      });
    }
    const response = await share(sharer.token, { layout });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: 'too_many_shares' });
  });

  it('keys the five-minute bucket by authenticated user, not by IP', async () => {
    const strictConfig = testConfig({
      shareRateLimit: { max: 1, windowMs: 5 * 60_000 },
      maxSharesPerUserPerDay: 5,
    });
    const strictApp = await buildServer({
      config: strictConfig,
      pool: fakePool,
      db: harness.db,
      webhookFetch,
    });
    try {
      const first = await tokenFor();
      const second = await tokenFor();
      const firstAccepted = await share(first.token, { layout }, strictApp);
      const sameUserAgain = await share(first.token, { layout }, strictApp);
      const sameIpDifferentUser = await share(second.token, { layout }, strictApp);
      expect(firstAccepted.statusCode).toBe(202);
      expect(sameUserAgain.statusCode).toBe(429);
      expect(sameIpDifferentUser.statusCode).toBe(202);
    } finally {
      await strictApp.close();
    }
  });
});
