/**
 * Configuration, from the environment only.
 *
 * No hostname or path is compiled in — a self-hoster sets these and nothing
 * else. See ADR 0001, decision 8.
 */

import * as os from 'node:os';
import * as path from 'node:path';

export interface RendererConfig {
  host: string;
  port: number;
  /** How many pages may render at once. This is a browser, not a function. */
  concurrency: number;
  /** Hard ceiling on one render, after which the page is torn down. */
  timeoutMs: number;
  /**
   * Refuse oversized bodies before a browser ever sees them. Bounds the
   * whole POST /render body, not just the layout JSON — #101's custom
   * (uploaded) furniture rides in the same request, base64-encoded, so this
   * has to have enough headroom for a handful of small sprite PNGs on top
   * of the layout itself.
   */
  maxLayoutBytes: number;
  /** Content-addressed PNGs. Survives restarts so a redeploy is not a stampede. */
  cacheDir: string;
  /** Set to 0 to disable the cache entirely. */
  cacheMaxEntries: number;
  upstreamDir?: string;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return Math.floor(value);
}

export function loadConfig(): RendererConfig {
  return {
    host: process.env.RENDERER_HOST ?? '::',
    port: intFromEnv('RENDERER_PORT', 3000),
    concurrency: Math.max(1, intFromEnv('RENDERER_CONCURRENCY', 2)),
    timeoutMs: intFromEnv('RENDERER_TIMEOUT_MS', 60_000),
    maxLayoutBytes: intFromEnv('RENDERER_MAX_LAYOUT_BYTES', 4_000_000),
    cacheDir:
      process.env.RENDERER_CACHE_DIR ?? path.join(os.tmpdir(), 'pixel-index-renderer-cache'),
    cacheMaxEntries: intFromEnv('RENDERER_CACHE_MAX_ENTRIES', 2000),
    ...(process.env.PIXEL_AGENTS_DIR ? { upstreamDir: process.env.PIXEL_AGENTS_DIR } : {}),
  };
}
