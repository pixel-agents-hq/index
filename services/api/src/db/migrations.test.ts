import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SYSTEM_USER_ID } from './constants.js';
import * as schema from './schema.js';
import { createTestDatabase, type Harness, migrateAgain, tableNames } from './test-support/harness.js';

describe('migrations', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createTestDatabase();
  });
  afterAll(async () => harness.close());

  it('runs from empty to current on a clean Postgres', async () => {
    expect(await tableNames(harness.client)).toEqual([
      'auth_login_codes',
      'auth_refresh_tokens',
      'discord_oauth_grants',
      'layout_tags',
      'layouts',
      'moderation_actions',
      'reports',
      'share_events',
      'tags',
      'users',
      'webhook_deliveries',
      'webhook_subscriptions',
    ]);
  });

  it('is idempotent — re-running applies nothing and throws nothing', async () => {
    // This is how the container entrypoint behaves: migrations run on every
    // boot, so a second run has to be a no-op rather than an error.
    await expect(migrateAgain(harness)).resolves.not.toThrow();
    expect(await tableNames(harness.client)).toContain('layouts');

    const users = await harness.db.select().from(schema.users);
    expect(users).toHaveLength(2); // the system user plus the bundled-layout author
  });

  it('creates the synthetic seed owner', async () => {
    const [systemUser] = await harness.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, SYSTEM_USER_ID));

    expect(systemUser?.isSystem).toBe(true);
    // Nothing can ever authenticate as it.
    expect(systemUser?.discordId).toBeNull();
  });

  it('creates or reuses the Discord-backed bundled-layout author', async () => {
    const [author] = await harness.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.discordId, '1528094749993599038'));
    expect(author).toMatchObject({ username: 'pablodelucca', isSystem: false, role: 'user' });
  });

  it('creates the indexes the public read paths depend on', async () => {
    const { rows } = await harness.client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'layouts'`,
    );
    const names = rows.map((row) => row.indexname);

    expect(names).toEqual(
      expect.arrayContaining([
        'layouts_slug_key',
        'layouts_public_created_idx',
        'layouts_public_author_idx',
        'layouts_public_search_idx',
        'layouts_public_stats_idx',
        'layouts_public_size_idx',
        'layouts_sha256_idx',
      ]),
    );
  });
});
