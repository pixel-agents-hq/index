/**
 * `X-Api-Key` — a dedicated header, never `Authorization`, following
 * `backup/export.ts`'s precedent: the human bearer-token session and a
 * machine credential must never be confused for one another mid-request.
 */

import type { FastifyRequest } from 'fastify';

const API_KEY_HEADER = 'x-api-key';

/**
 * `undefined` means no key was presented at all — distinct from "a key was
 * presented but doesn't verify" (`issue.ts`'s `verifyApiKey` returning
 * `null`). A caller needs both: "fall through to the other auth method" is
 * only correct for the first case.
 */
export function presentedApiKey(request: FastifyRequest): string | undefined {
  const value = request.headers[API_KEY_HEADER];
  return typeof value === 'string' ? value : undefined;
}
