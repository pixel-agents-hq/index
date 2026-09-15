import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';

import { signAccessToken } from '../auth/tokens.js';
import { one } from '../db/rows.js';
import * as schema from '../db/schema.js';
import { createTestDatabase, type Harness } from '../db/test-support/harness.js';
import { buildServer } from '../server.js';
import { simpleAssetZip } from '../test-support/assetZip.js';
import { testConfig } from '../test-support/config.js';
import { insertUser } from '../test-support/layouts.js';
import type { PublicCustomAssetDetail } from './serialize.js';

const config = testConfig({ writeRateLimit: { max: 1000, windowMs: 60_000 } });
const fakePool = { query: async () => ({ rows: [] }) };

let harness: Harness;
let app: FastifyInstance;
beforeAll(async () => {
  harness = await createTestDatabase();
  app = await buildServer({ config, pool: fakePool, db: harness.db });
});

async function tokenFor(overrides: Parameters<typeof insertUser>[1] = {}) {
  const user = await insertUser(harness.db, overrides);
  const accessToken = await signAccessToken(
    { sub: user.id, role: user.role },
    config.sessionSecret,
    config.accessTokenTtlMs,
  );
  return { user, accessToken };
}

/** A published custom-furniture asset owned by a fresh user, for tests that delete it. */
async function ownedAsset(assetId: string) {
  const { user, accessToken } = await tokenFor();
  await harness.db.insert(schema.customAssets).values({
    assetKind: 'furniture',
    assetId,
    requestedAssetId: assetId,
    name: assetId,
    category: 'chairs',
    manifest: [
      {
        id: assetId,
        name: assetId,
        label: assetId,
        category: 'chairs',
        file: `${assetId}.png`,
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        canPlaceOnWalls: false,
        groupId: assetId,
      },
    ],
    sprites: { [assetId]: Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => '#ff00ff')) },
    rawZip: Buffer.from('fake zip'),
    authorUserId: user.id,
    source: 'custom',
  });
  return { user, accessToken };
}

async function insertBuiltinAsset(assetId: string) {
  const system = await insertUser(harness.db, { username: `builtin-author-${assetId}` });
  await harness.db.insert(schema.customAssets).values({
    assetKind: 'furniture',
    assetId,
    requestedAssetId: assetId,
    name: assetId,
    category: 'chairs',
    manifest: [{ id: assetId, name: assetId }],
    sprites: {},
    rawZip: Buffer.from('fake zip'),
    authorUserId: system.id,
    source: 'builtin',
    sourceCommit: 'a'.repeat(40),
  });
}

async function getAssetRowByAssetId(assetId: string): Promise<schema.CustomAsset> {
  return one(await harness.db.select().from(schema.customAssets).where(eq(schema.customAssets.assetId, assetId)));
}

function del(assetId: string, accessToken?: string, body?: { reason?: string }) {
  return app.inject({
    method: 'DELETE',
    url: `/api/v1/assets/${assetId}`,
    ...(body !== undefined ? { payload: body } : {}),
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
}

describe('DELETE /api/v1/assets/:assetId — owner or moderator deletion (#125)', () => {
  it('is impossible anonymously', async () => {
    await ownedAsset('DEL_ANON');
    const response = await del('DEL_ANON');
    expect(response.statusCode).toBe(401);
  });

  it('404s for an unknown assetId', async () => {
    const { accessToken } = await tokenFor();
    const response = await del('DEL_UNKNOWN', accessToken);
    expect(response.statusCode).toBe(404);
  });

  it('refuses a stranger — neither the owner nor a moderator', async () => {
    await ownedAsset('DEL_STRANGER');
    const { accessToken: stranger } = await tokenFor();
    const response = await del('DEL_STRANGER', stranger);
    expect(response.statusCode).toBe(403);
  });

  it('deletes and is idempotent on re-delete, no reason required for an owner', async () => {
    const { accessToken } = await ownedAsset('DEL_OWNER');
    const first = await del('DEL_OWNER', accessToken);
    expect(first.statusCode).toBe(204);

    const row = await getAssetRowByAssetId('DEL_OWNER');
    expect(row.deletedAt).not.toBeNull();

    const gone = await app.inject({ method: 'GET', url: '/api/v1/assets/DEL_OWNER' });
    expect(gone.statusCode).toBe(404);

    const second = await del('DEL_OWNER', accessToken);
    expect(second.statusCode).toBe(204);
  });

  it('removes the asset from the public listing once deleted', async () => {
    const { accessToken } = await ownedAsset('DEL_LISTED');
    const before = await app.inject({ method: 'GET', url: '/api/v1/assets?limit=100' });
    expect(before.json<{ assets: { assetId: string }[] }>().assets.map((a) => a.assetId)).toContain('DEL_LISTED');

    const response = await del('DEL_LISTED', accessToken);
    expect(response.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/api/v1/assets?limit=100' });
    expect(after.json<{ assets: { assetId: string }[] }>().assets.map((a) => a.assetId)).not.toContain(
      'DEL_LISTED',
    );
  });

  it("lets a moderator delete someone else's asset, with a reason", async () => {
    await ownedAsset('DEL_MOD');
    const { accessToken: modToken, user: moderator } = await tokenFor({ role: 'moderator' });
    const response = await del('DEL_MOD', modToken, { reason: 'policy violation' });
    expect(response.statusCode).toBe(204);

    const row = await getAssetRowByAssetId('DEL_MOD');
    expect(row.deletedAt).not.toBeNull();

    const entries = await harness.db
      .select()
      .from(schema.moderationActions)
      .where(eq(schema.moderationActions.targetId, row.id));
    const deleteEntry = entries.find((entry) => entry.action === 'asset.delete');
    expect(deleteEntry?.actorUserId).toBe(moderator.id);
    expect(deleteEntry?.reason).toBe('policy violation');
  });

  it("requires a reason when a moderator deletes someone else's asset", async () => {
    await ownedAsset('DEL_MOD_NOREASON');
    const { accessToken: modToken } = await tokenFor({ role: 'moderator' });
    const response = await del('DEL_MOD_NOREASON', modToken);
    expect(response.statusCode).toBe(400);

    const row = await getAssetRowByAssetId('DEL_MOD_NOREASON');
    expect(row.deletedAt).toBeNull();
  });

  it('needs no reason when a moderator deletes their OWN asset — same as any owner', async () => {
    const { accessToken: modToken, user: moderator } = await tokenFor({ role: 'moderator' });
    await harness.db.insert(schema.customAssets).values({
      assetKind: 'furniture',
      assetId: 'DEL_MOD_OWN',
      requestedAssetId: 'DEL_MOD_OWN',
      name: 'DEL_MOD_OWN',
      category: 'chairs',
      manifest: [{ id: 'DEL_MOD_OWN', name: 'DEL_MOD_OWN' }],
      sprites: {},
      rawZip: Buffer.from('fake zip'),
      authorUserId: moderator.id,
      source: 'custom',
    });
    const response = await del('DEL_MOD_OWN', modToken);
    expect(response.statusCode).toBe(204);

    const entries = await harness.db
      .select()
      .from(schema.moderationActions)
      .where(eq(schema.moderationActions.targetId, (await getAssetRowByAssetId('DEL_MOD_OWN')).id));
    const deleteEntry = entries.find((entry) => entry.action === 'asset.delete');
    expect(deleteEntry?.reason).toBeNull();
  });

  it('is idempotent for a moderator re-deleting an already-deleted asset too, without demanding a reason', async () => {
    const { accessToken } = await ownedAsset('DEL_MOD_IDEMPOTENT');
    const owned = await del('DEL_MOD_IDEMPOTENT', accessToken);
    expect(owned.statusCode).toBe(204);

    const { accessToken: modToken } = await tokenFor({ role: 'moderator' });
    const response = await del('DEL_MOD_IDEMPOTENT', modToken);
    expect(response.statusCode).toBe(204);
  });

  it('refuses to delete a built-in asset, even for an admin, and leaves it untouched', async () => {
    await insertBuiltinAsset('DEL_BUILTIN');
    const { accessToken: adminToken } = await tokenFor({ role: 'admin' });
    const response = await del('DEL_BUILTIN', adminToken);
    expect(response.statusCode).toBe(403);

    const row = await getAssetRowByAssetId('DEL_BUILTIN');
    expect(row.deletedAt).toBeNull();
  });

  it("never reuses a deleted asset's id for a later, unrelated upload", async () => {
    const { accessToken } = await tokenFor();
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      payload: await simpleAssetZip('DEL_REUSE', { name: 'First' }),
      headers: { 'content-type': 'application/zip', authorization: `Bearer ${accessToken}` },
    });
    expect(first.statusCode).toBe(201);
    const firstAsset = first.json<PublicCustomAssetDetail>();
    expect(firstAsset.assetId).toBe('DEL_REUSE');

    const deleteResponse = await del('DEL_REUSE', accessToken);
    expect(deleteResponse.statusCode).toBe(204);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      payload: await simpleAssetZip('DEL_REUSE', { name: 'Second' }),
      headers: { 'content-type': 'application/zip', authorization: `Bearer ${accessToken}` },
    });
    expect(second.statusCode).toBe(201);
    const secondAsset = second.json<PublicCustomAssetDetail>();
    // The requested id was already permanently taken by the deleted row, so
    // the collision check (existingCustomAssetIds, query.ts) assigns a
    // fresh, distinct id rather than reusing "DEL_REUSE".
    expect(secondAsset.assetId).not.toBe('DEL_REUSE');
  });
});
