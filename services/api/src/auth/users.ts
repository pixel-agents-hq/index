/**
 * User upsert on login.
 *
 * Discord username and avatar are cached display data — refreshed on every
 * login and Discord membership checks, allowed to go stale between them.
 * Capability is resolved separately from Discord/config, never granted here.
 */

import { eq } from 'drizzle-orm';

import type { AnyDatabase } from '../db/client.js';
import { one } from '../db/rows.js';
import * as schema from '../db/schema.js';
import type { DiscordUser } from './discord.js';
import { discordAvatarUrl } from './discord.js';

export async function upsertDiscordUser(
  db: AnyDatabase,
  discordUser: DiscordUser,
): Promise<schema.User> {
  const avatarUrl = discordAvatarUrl(discordUser);

  const [existing] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.discordId, discordUser.id));

  if (existing) {
    return one(
      await db
        .update(schema.users)
        .set({
          username: discordUser.username,
          globalName: discordUser.globalName ?? null,
          avatarUrl,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, existing.id))
        .returning(),
    );
  }

  return one(
    await db
      .insert(schema.users)
      .values({
        discordId: discordUser.id,
        username: discordUser.username,
        globalName: discordUser.globalName ?? null,
        avatarUrl,
      })
      .returning(),
  );
}

/**
 * A user row for a Discord id that has never logged into the web app itself
 * (#101) — a bot-originated custom-asset upload knows only the invoking
 * Discord user's id, not their username/avatar. Reuses this table's own
 * `discordId` lookup key rather than a separate "ghost user" table: the
 * *existing* login-time upsert above (`upsertDiscordUser`) reconciles the
 * stub with real profile data automatically, the moment that Discord user
 * ever does log in themselves — same row, same id, filled in.
 *
 * The stub's `username` is a placeholder, not a real Discord handle — it is
 * only ever shown back as an author credit until the reconciliation above
 * overwrites it.
 */
export async function resolveOrCreateGhostUser(db: AnyDatabase, discordId: string): Promise<schema.User> {
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.discordId, discordId));
  if (existing) return existing;

  return one(
    await db
      .insert(schema.users)
      .values({ discordId, username: `discord:${discordId}` })
      .returning(),
  );
}

/**
 * The fresh row behind an access token's `{id}` claim. `resolveUser`
 * (context.ts) deliberately never does this — it is the stateless-access-token
 * trade-off's whole point — capability.ts and owner routes fetch the complete
 * row because Discord-derived state and attribution do not live in the JWT.
 */
export async function getUserById(db: AnyDatabase, id: string): Promise<schema.User | null> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, id));
  return user ?? null;
}
