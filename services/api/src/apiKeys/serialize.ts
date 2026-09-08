/** The moderator-facing view of an API key — never the hash, let alone the plaintext value. */

import type * as schema from '../db/schema.js';

export interface ApiKeyView {
  id: string;
  label: string;
  createdByUserId: string;
  revoked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export function toApiKeyView(key: schema.ApiKey): ApiKeyView {
  return {
    id: key.id,
    label: key.label,
    createdByUserId: key.createdByUserId,
    revoked: key.revokedAt !== null,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
  };
}
