/**
 * Default avatars for accounts without a picture (#133).
 *
 * Every user row gets a pixatar seed code once, dealt from its own internal
 * `id`: stable, unique, and not something that identifies a person outside
 * this database (unlike a Discord username or an email address, and the code
 * says nothing about the id it was dealt from). The code is then stored, as
 * pixatar's README recommends: a code is the character itself and keeps it
 * across vendor bumps, while the text it was dealt from may be dealt
 * differently by a wardrobe with more parts.
 *
 * It is only *shown* where `avatarUrl` is null: an avatar someone has (their
 * Discord one) always wins. There is no picking or rerolling yet.
 */

import { randomUUID } from 'node:crypto';

import { seedFromText } from '@pixel-index/pixatar';

/** The seed code dealt from a user id. Only for rows that have none yet. */
export function defaultAvatarSeed(userId: string): string {
  return seedFromText(`pixel-index:user:${userId}`);
}

/**
 * An id and its default avatar seed, for a new user row. The id is made here
 * rather than by the column's `defaultRandom()` so the seed can be dealt from
 * it in the same insert.
 */
export function newUserIdentity(): { id: string; avatarSeed: string } {
  const id = randomUUID();
  return { id, avatarSeed: defaultAvatarSeed(id) };
}
