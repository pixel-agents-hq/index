/**
 * A thin fetch wrapper for the public layout API (#6), extended for
 * authenticated calls (#15). No hostname lives here or anywhere else in
 * this app — `VITE_API_BASE_URL` is build-time config with a documented
 * local-dev default (see `.env.example`), so a self-hoster's deployment
 * never has to grep the source for a hardcoded domain and replace it with
 * their own.
 */
import type { OpenApiDocument } from './openapi';
import type {
  ApiInfo,
  AssetDetail,
  LayoutDetail,
  ListAssetsParams,
  ListAssetsResponse,
  ListLayoutsParams,
  ListLayoutsResponse,
  ListTagsResponse,
  MetaResponse,
  PublicAuthorResponse,
} from './types';

// `||`, not `??`: an unset GitHub Actions repo variable interpolates to an
// empty string, not undefined, and an empty base URL would silently turn
// every request into a same-origin call against the Pages domain itself —
// a confusing 404 instead of the clear "unreachable" message this is meant
// to produce.
const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  /** Populated for a 422 from layout-core validation (submit, replace, preview-check) — field/furniture-id-naming issues, not just a generic message. */
  readonly issues: ValidationIssue[] | null;

  constructor(status: number, message: string, issues: ValidationIssue[] | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.issues = issues;
  }
}

export interface RequestOptions {
  method?: string;
  /**
   * A string sends as-is (used where byte-exact JSON matters — submit,
   * replace). An object is JSON.stringify'd. A `Blob` sends as-is too (#101's
   * custom-asset zip upload) — pair it with an explicit `headers['content-type']`,
   * since a `Blob` body skips this function's own JSON default.
   */
  body?: string | object | Blob;
  accessToken?: string;
  headers?: Record<string, string>;
  /** Set for endpoints that return bytes (preview-check) rather than JSON. */
  parseAs?: 'json' | 'blob' | 'text' | 'none';
  /**
   * Cancels the request when the caller stops wanting the answer — an
   * unmounted screen, a superseded filter. Only the read-only wrappers below
   * accept one; see the note above the mutating clients for why they do not.
   *
   * Spelled `| undefined` rather than a bare `signal?: AbortSignal`, and that
   * is load-bearing under exactOptionalPropertyTypes: every wrapper forwards
   * its own *optional* parameter straight through as `{ signal }`, and without
   * the explicit undefined that assignment is an error at all ten call sites.
   */
  signal?: AbortSignal | undefined;
}

/**
 * One request.
 *
 * The rejection contract, which every caller's `.catch` depends on: **if the
 * caller's signal aborted, this rejects with the abort — never with an
 * `ApiError`. Every other failure is an `ApiError`.**
 */
async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, accessToken, headers = {}, parseAs = 'json', signal } = options;

  // An already-aborted signal must not become a request. Not a micro-
  // optimisation: StrictMode mounts, cleans up and remounts every effect in
  // development, so without this the first mount's request is sent purely to
  // be cancelled a tick later.
  signal?.throwIfAborted();

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined && !(body instanceof Blob) ? { 'content-type': 'application/json' } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...headers,
      },
      ...(body !== undefined
        ? { body: typeof body === 'string' || body instanceof Blob ? body : JSON.stringify(body) }
        : {}),
      // `?? null`, not `signal`. RequestInit declares `signal?: AbortSignal | null`
      // with no `| undefined`, and exactOptionalPropertyTypes makes an explicit
      // undefined an error; `null` is the spec's own spelling of "no signal".
      signal: signal ?? null,
    });
  } catch (cause) {
    // An abort is not a failure. It is this app deciding it no longer wants
    // the answer, and normalizing it into the message below would put "Could
    // not reach the API" in front of a user whose network is fine — raised by
    // the very effect that cancelled the request.
    //
    // The test is our own signal, not the error's shape. `name === 'AbortError'`
    // is the documented contract, but the *class* carrying it differs by
    // runtime (undici builds its own DOMException, jsdom another), so
    // `instanceof DOMException` is a cross-realm trap in exactly the
    // environment this is tested in. `signal.aborted` is a boolean we own.
    if (signal?.aborted) throw cause;

    // A network failure (API down, CORS misconfigured, offline) throws
    // TypeError, not something with a status — normalized here so every
    // caller has one error shape to render a message from, per #12's
    // "degrades legibly" acceptance criterion.
    throw new ApiError(0, 'Could not reach the API. It may be down, or unreachable from here.');
  }

  if (!response.ok) {
    // The API's error envelope (errors.ts) is always { error, message } and,
    // for a 422, { issues: [...] } too — surfacing the real message (a
    // required reason, a rejected furniture id, a rate limit) is the whole
    // difference between an actionable form error and "The API returned
    // 422", per #15's own acceptance criteria.
    let message = `The API returned ${response.status} for ${path}.`;
    let issues: ValidationIssue[] | null = null;
    try {
      const errorBody = (await response.json()) as { message?: string; issues?: ValidationIssue[] };
      if (errorBody.message) message = errorBody.message;
      if (errorBody.issues) issues = errorBody.issues;
    } catch (cause) {
      // The other place an abort could be laundered into an ApiError:
      // aborting mid-body-read rejects response.json(), and swallowing that
      // would surface a 500 nobody is waiting for.
      if (signal?.aborted) throw cause;
      /* not JSON — keep the generic message */
    }
    throw new ApiError(response.status, message, issues);
  }

  if (parseAs === 'none') return undefined as T;
  if (parseAs === 'blob') return (await response.blob()) as T;
  if (parseAs === 'text') return (await response.text()) as T;
  return (await response.json()) as T;
}

function toQueryString(params: object): string {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined) as [string, string | number][];
  if (entries.length === 0) return '';
  return `?${new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString()}`;
}

export function listLayouts(
  params: ListLayoutsParams = {},
  signal?: AbortSignal,
): Promise<ListLayoutsResponse> {
  return apiRequest(`/api/v1/layouts${toQueryString(params)}`, { signal });
}

export function getLayout(slug: string, signal?: AbortSignal): Promise<LayoutDetail> {
  return apiRequest(`/api/v1/layouts/${encodeURIComponent(slug)}`, { signal });
}

export function getAuthor(id: string, signal?: AbortSignal): Promise<PublicAuthorResponse> {
  return apiRequest(`/api/v1/authors/${encodeURIComponent(id)}`, { signal });
}

export function listAssets(params: ListAssetsParams = {}, signal?: AbortSignal): Promise<ListAssetsResponse> {
  return apiRequest(`/api/v1/assets${toQueryString(params)}`, { signal });
}

export function getAsset(assetId: string, signal?: AbortSignal): Promise<AssetDetail> {
  return apiRequest(`/api/v1/assets/${encodeURIComponent(assetId)}`, { signal });
}

/** Exact uploaded layout.json text; callers may format it for presentation. */
export function getLayoutJson(slug: string, signal?: AbortSignal): Promise<string> {
  return apiRequest(`/api/v1/layouts/${encodeURIComponent(slug)}/download`, { parseAs: 'text', signal });
}

export function getMeta(signal?: AbortSignal): Promise<MetaResponse> {
  return apiRequest('/api/v1/meta', { signal });
}

export function listTags(signal?: AbortSignal): Promise<ListTagsResponse> {
  return apiRequest('/api/v1/tags', { signal });
}

/** `GET /` (#32) — the developer landing document: version, commit, and where to find the rest. */
export function getApiInfo(signal?: AbortSignal): Promise<ApiInfo> {
  return apiRequest('/', { signal });
}

/** The same document `@fastify/swagger` serves at `/docs` — the DeveloperPage renders its own reference from this. */
export function getOpenApiSpec(signal?: AbortSignal): Promise<OpenApiDocument> {
  return apiRequest('/openapi.json', { signal });
}

/**
 * `LayoutSummary.files` (preview/thumbnail/layout) are API-relative paths,
 * not full URLs — the API doesn't know its own public origin at response
 * time (self-hosters run it behind arbitrary hostnames). This is the one
 * place that turns one into something an `<img src>` or `<a href>` can use.
 */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

/**
 * A link to a file in this instance's own repository, pinned to the exact
 * commit `GET /` reports — the file existed there for certain, unlike a
 * `main` branch link a later rename or move could break. Falls back to
 * `main` only for a self-hosted deployment that never set `API_COMMIT`
 * (services/api's config.ts), where there is no commit to pin to.
 */
export function repoFileUrl(info: ApiInfo, path: string): string {
  return `${info.repository}/blob/${info.commit ?? 'main'}/${path}`;
}

export { API_BASE_URL, apiRequest, toQueryString };
