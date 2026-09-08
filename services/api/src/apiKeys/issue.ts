/** SQL for moderator-issued API keys — create, revoke, list, verify-by-hash. */

import { eq } from 'drizzle-orm';

import { generateOpaqueToken, hashToken } from '../auth/tokens.js';
import type { AnyDatabase } from '../db/client.js';
import { one } from '../db/rows.js';
import * as schema from '../db/schema.js';

export interface IssuedApiKey {
  key: schema.ApiKey;
  /** Given to the caller exactly once, in the create response. Never persisted. */
  value: string;
}

export async function issueApiKey(
  db: AnyDatabase,
  { createdByUserId, label }: { createdByUserId: string; label: string },
): Promise<IssuedApiKey> {
  const token = generateOpaqueToken();
  const key = one(
    await db
      .insert(schema.apiKeys)
      .values({ createdByUserId, label, keyHash: token.hash })
      .returning(),
  );
  return { key, value: token.value };
}

export async function revokeApiKey(db: AnyDatabase, id: string): Promise<schema.ApiKey | null> {
  const [row] = await db
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(eq(schema.apiKeys.id, id))
    .returning();
  return row ?? null;
}

export async function listApiKeys(db: AnyDatabase): Promise<schema.ApiKey[]> {
  return db.select().from(schema.apiKeys).orderBy(schema.apiKeys.createdAt);
}

/** `null` for a missing, revoked key — the caller doesn't get to tell which. */
export async function verifyApiKey(db: AnyDatabase, presented: string): Promise<schema.ApiKey | null> {
  const hash = hashToken(presented);
  const [row] = await db
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.keyHash, hash));
  if (row?.revokedAt !== null) return null;

  await db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, row.id));
  return row;
}
