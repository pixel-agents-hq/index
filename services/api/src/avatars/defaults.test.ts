import { isSeedCode, pixatar } from '@pixel-index/pixatar';
import { eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveOrCreateGhostUser, upsertDiscordUser } from '../auth/users.js';
import { backfillAvatarSeeds } from '../db/backfill-avatar-seeds.js';
import * as schema from '../db/schema.js';
import { createTestDatabase, type Harness } from '../db/test-support/harness.js';
import { resolveAuthorFromMeta } from '../layouts/query.js';
import { defaultAvatarSeed, newUserIdentity } from './defaults.js';

let harness: Harness | undefined;
beforeEach(async () => {
  harness = await createTestDatabase();
});
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function db(): Harness['db'] {
  if (!harness) throw new Error('this test did not create a database');
  return harness.db;
}

describe('defaultAvatarSeed', () => {
  it('deals a drawable seed code from a user id, the same one every time', () => {
    const id = '0b6f7f2e-6a3c-4c63-9a3e-9d1b8d1f0c11';
    const seed = defaultAvatarSeed(id);
    expect(isSeedCode(seed)).toBe(true);
    expect(defaultAvatarSeed(id)).toBe(seed);
    expect(defaultAvatarSeed('another-id')).not.toBe(seed);
    expect(pixatar(seed).avatarPng().length).toBeGreaterThan(0);
  });

  it('newUserIdentity pairs a fresh id with its seed', () => {
    const { id, avatarSeed } = newUserIdentity();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(avatarSeed).toBe(defaultAvatarSeed(id));
  });
});

describe('every way a user row is made stores its default avatar seed', () => {
  it('a Discord login', async () => {
    const user = await upsertDiscordUser(db(), { id: '9001', username: 'alice', globalName: null, avatar: null });
    expect(user.avatarSeed).toBe(defaultAvatarSeed(user.id));
  });

  it('a bot-originated ghost user, and the login that later fills it in keeps it', async () => {
    const ghost = await resolveOrCreateGhostUser(db(), '9002');
    expect(ghost.avatarUrl).toBeNull();
    expect(ghost.avatarSeed).toBe(defaultAvatarSeed(ghost.id));

    const real = await upsertDiscordUser(db(), { id: '9002', username: 'bob', globalName: null, avatar: 'abc' });
    expect(real.id).toBe(ghost.id);
    expect(real.avatarSeed).toBe(ghost.avatarSeed);
  });

  it('a seed or backup author credited by Discord id', async () => {
    const { authorUserId } = await resolveAuthorFromMeta(db(), { author: 'carol', authorDiscordId: '9003' });
    const [row] = await db().select().from(schema.users).where(eq(schema.users.id, authorUserId));
    expect(row?.avatarSeed).toBe(defaultAvatarSeed(authorUserId));
  });
});

describe('backfillAvatarSeeds', () => {
  it('deals a seed to rows from before the column, and never rewrites one that is set', async () => {
    const kept = await upsertDiscordUser(db(), { id: '9101', username: 'kept', globalName: null, avatar: null });
    await db().update(schema.users).set({ avatarSeed: 'px.picked-earlier' }).where(eq(schema.users.id, kept.id));
    const old = await upsertDiscordUser(db(), { id: '9102', username: 'old', globalName: null, avatar: null });
    await db().update(schema.users).set({ avatarSeed: null }).where(eq(schema.users.id, old.id));

    // The migrated system user (0016) predates the column too.
    expect(await backfillAvatarSeeds(db())).toBeGreaterThanOrEqual(1);

    const rows = await db().select().from(schema.users);
    const byId = new Map(rows.map((row) => [row.id, row.avatarSeed]));
    expect(byId.get(kept.id)).toBe('px.picked-earlier');
    expect(byId.get(old.id)).toBe(defaultAvatarSeed(old.id));
    expect(await db().select().from(schema.users).where(isNull(schema.users.avatarSeed))).toEqual([]);

    // Idempotent: a second boot deals nothing.
    expect(await backfillAvatarSeeds(db())).toBe(0);
  });
});
