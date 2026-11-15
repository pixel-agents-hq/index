/**
 * Shared row-insertion helpers for the layout-route test suites. #6's data
 * layer has no writer of its own yet (#8, #18) — this stands in for it.
 */

import { eq } from 'drizzle-orm';

import { newUserIdentity } from '../avatars/defaults.js';
import type { AnyDatabase } from '../db/client.js';
import { SYSTEM_USER_ID } from '../db/constants.js';
import { one } from '../db/rows.js';
import * as schema from '../db/schema.js';

const A_HASH = (n: number) => n.toString(16).padStart(64, '0');
let counter = 0;

export async function insertUser(
  db: AnyDatabase,
  overrides: Partial<schema.NewUser> = {},
): Promise<schema.User> {
  counter += 1;
  return one(
    await db
      .insert(schema.users)
      .values({
        ...newUserIdentity(),
        discordId: `discord-${counter}`,
        username: `user-${counter}`,
        role: 'user',
        ...overrides,
      })
      .returning(),
  );
}

export async function insertLayout(
  db: AnyDatabase,
  overrides: Partial<schema.NewLayout> = {},
): Promise<schema.Layout> {
  counter += 1;
  const raw = overrides.raw ?? JSON.stringify({ version: 1, seq: counter });
  return one(
    await db
    .insert(schema.layouts)
    .values({
      slug: `layout-${counter}`,
      title: `Layout ${counter}`,
      authorUserId: SYSTEM_USER_ID,
      raw,
      layout: JSON.parse(raw),
      sha256: A_HASH(counter),
      cols: 10,
      rows: 10,
      visibleCols: 10,
      visibleRows: 10,
      furnitureCount: 0,
      areaCount: 0,
      petCount: 0,
      carpetCount: 0,
      seatCount: 0,
      ...overrides,
    })
    .returning(),
  );
}

export async function insertTag(db: AnyDatabase, name: string): Promise<schema.Tag> {
  const [existing] = await db.select().from(schema.tags).where(eq(schema.tags.name, name));
  if (existing) return existing;
  return one(await db.insert(schema.tags).values({ name }).returning());
}

export async function tagLayout(db: AnyDatabase, layoutId: string, tagName: string): Promise<void> {
  const tag = await insertTag(db, tagName);
  await db.insert(schema.layoutTags).values({ layoutId, tagId: tag.id });
}
