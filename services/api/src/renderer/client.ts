/**
 * A thin client for the renderer service (#4).
 *
 * The API never draws a pixel itself — it stores a validated layout and, on
 * request, asks the renderer to draw it. `fetch` is injectable so routes can
 * be tested without a live renderer.
 */

import type { RenderCustomAsset } from './customAssets.js';

const RENDER_TIMEOUT_MS = 65_000; // the renderer's own default is 60s per render

export interface PreviewResult {
  body: Buffer;
  contentType: string;
  /** The renderer's own content-addressed etag — reused as ours. */
  etag: string | null;
  cacheStatus: 'hit' | 'miss' | null;
}

export type PreviewFailure =
  | { kind: 'invalid_layout'; issues: unknown }
  | { kind: 'unavailable'; message: string };

export interface RequestPreviewOptions {
  /** Custom furniture the layout references (#101) — see `customAssets.ts`. Omit or empty for a layout with none. */
  customAssets?: RenderCustomAsset[];
  fetchImpl?: typeof fetch;
}

export async function requestPreview(
  rendererUrl: string,
  layout: unknown,
  { customAssets = [], fetchImpl = fetch }: RequestPreviewOptions = {},
): Promise<{ ok: true; result: PreviewResult } | { ok: false; error: PreviewFailure }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);

  try {
    // Always scale 1: a full, un-shrunk render. See routes.ts's thumbnail.png
    // handler for why nothing here ever asks the renderer for a smaller scale.
    const response = await fetchImpl(new URL('/render', rendererUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout, scale: 1, ...(customAssets.length > 0 ? { customAssets } : {}) }),
      signal: controller.signal,
    });

    if (response.status === 422) {
      const body = (await response.json().catch(() => ({}))) as { issues?: unknown };
      return { ok: false, error: { kind: 'invalid_layout', issues: body.issues ?? [] } };
    }
    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText);
      return { ok: false, error: { kind: 'unavailable', message: message || response.statusText } };
    }

    const body = Buffer.from(await response.arrayBuffer());
    const cacheStatus = response.headers.get('x-render-cache');
    return {
      ok: true,
      result: {
        body,
        contentType: response.headers.get('content-type') ?? 'image/png',
        etag: response.headers.get('etag'),
        cacheStatus: cacheStatus === 'hit' || cacheStatus === 'miss' ? cacheStatus : null,
      },
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? `Renderer did not respond within ${RENDER_TIMEOUT_MS}ms.`
        : `Could not reach the renderer: ${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, error: { kind: 'unavailable', message } };
  } finally {
    clearTimeout(timer);
  }
}
