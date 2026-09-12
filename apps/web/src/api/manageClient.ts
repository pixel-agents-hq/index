/**
 * Everything an owner does to their own layout (#9/#15): submit, check a
 * preview before publishing, edit, replace the content, delete, and list
 * what they own. All require an access token — except `previewCheck`, which
 * doesn't persist anything and doesn't need Discord membership either, so
 * the layout editor's create path (#85) can offer it to anonymous visitors
 * too. Everything else here still has no anonymous path, unlike every
 * function in client.ts.
 */
import { apiRequest, toQueryString } from './client';
import type {
  AssetDetail,
  LayoutDetail,
  ListOwnerLayoutsResponse,
  OwnerLayoutView,
  PatchLayoutBody,
  SubmitLayoutParams,
} from './types';

export interface SubmitResult extends LayoutDetail {
  previewReady: boolean;
}

/**
 * None of the mutating calls below takes an `AbortSignal`, and that is the
 * enforcement rather than an oversight: aborting a POST/PATCH/PUT/DELETE does
 * not un-send it — the server may already have committed the write — so a
 * "cancelled" mutation would be a lie about state. Under StrictMode an
 * abort-on-cleanup would additionally fire-then-abort every write in
 * development. Only read-only GETs are cancellable.
 */
export function submitLayout(
  raw: string,
  params: SubmitLayoutParams,
  accessToken: string,
): Promise<SubmitResult> {
  return apiRequest(`/api/v1/layouts${toQueryString(params)}`, { method: 'POST', body: raw, accessToken });
}

/**
 * Nothing is persisted — see services/api's own note on this route. Returns
 * a PNG blob to feed an <img> via createObjectURL.
 *
 * `accessToken` is optional, unlike every other function here: the API
 * route itself doesn't require one (#85). Callers that already gate the
 * rest of their page behind login (SubmitPage, the edit-existing path) will
 * still have one to pass; the editor's create path does not, once logged
 * out.
 */
export function previewCheck(raw: string, accessToken?: string): Promise<Blob> {
  return apiRequest('/api/v1/layouts/preview-check', {
    method: 'POST',
    body: raw,
    ...(accessToken !== undefined ? { accessToken } : {}),
    parseAs: 'blob',
  });
}

/**
 * Publishes a custom asset (furniture, character, or pet — #101, #105
 * follow-up) — a zip whose own contents (manifest.json, PNG dimensions) tell
 * the server everything it needs (kind, name, category), so this call takes
 * no params beyond the file itself. Same "no un-send" reasoning as every
 * other mutating call here, hence no `AbortSignal`. No pre-publish preview
 * step (that's #102's job); the server validates and, on success, the asset
 * is live in this same response.
 */
export function submitAsset(zip: Blob, accessToken: string): Promise<AssetDetail> {
  return apiRequest('/api/v1/assets', {
    method: 'POST',
    body: zip,
    accessToken,
    headers: { 'content-type': 'application/zip' },
  });
}

export function getMyLayouts(
  params: { limit?: number; cursor?: string },
  accessToken: string,
  signal?: AbortSignal,
): Promise<ListOwnerLayoutsResponse> {
  return apiRequest(`/api/v1/me/layouts${toQueryString(params)}`, { accessToken, signal });
}

export function patchLayout(
  slug: string,
  body: PatchLayoutBody,
  accessToken: string,
): Promise<OwnerLayoutView> {
  return apiRequest(`/api/v1/layouts/${encodeURIComponent(slug)}`, { method: 'PATCH', body, accessToken });
}

export function replaceLayoutContent(
  slug: string,
  raw: string,
  accessToken: string,
): Promise<OwnerLayoutView & { previewReady: boolean }> {
  return apiRequest(`/api/v1/layouts/${encodeURIComponent(slug)}/layout`, {
    method: 'PUT',
    body: raw,
    accessToken,
  });
}

/**
 * Owner or moderator (#72) — a moderator deleting someone else's layout must
 * pass `reason`; an owner deleting their own does not, and omitting the
 * param entirely (rather than passing `reason: undefined`) keeps that call
 * bodyless, exactly as it always was before a moderator could reach this too.
 */
export function deleteLayout(slug: string, accessToken: string, reason?: string): Promise<void> {
  return apiRequest(`/api/v1/layouts/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    accessToken,
    parseAs: 'none',
    ...(reason !== undefined ? { body: { reason } } : {}),
  });
}
