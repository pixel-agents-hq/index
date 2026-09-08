/**
 * Content-addressed PNG cache.
 *
 * Keyed on the layout bytes *and* the upstream pin, because bumping
 * `vendor/pixel-agents` can change what a layout looks like — a cache that
 * ignored the pin would serve a preview from the previous renderer forever.
 *
 * And on RENDER_FORMAT, because this service can change what a layout looks
 * like without upstream moving at all. #71 did exactly that: the same layout,
 * the same pin, a different image. Without this, every layout already rendered
 * would keep serving its untrimmed white PNG until the pin next happened to
 * move — the fix would ship and change nothing anyone could see.
 *
 * On disk rather than in memory so a redeploy is not a render stampede, and
 * because a submission that duplicates an existing layout (#8 dedupes on the
 * same hash) should cost nothing at all.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { sha256 } from '@pixel-index/layout-core';

/**
 * Bump whenever a render of the *same* layout at the *same* pin would come out
 * different. `2`: cropped to the occupied tiles, with a transparent background
 * rather than a white one (#71).
 */
export const RENDER_FORMAT = 2;

export interface CacheKeyParts {
  layoutBytes: string;
  upstreamCommit: string | null;
  upstreamVersion: string | null;
  scale: number;
  /**
   * The exact custom-assets payload the request carried (#101), serialised —
   * not just "were there any". A custom asset is immutable once published
   * (no edit endpoint exists), so this can't go stale in practice today, but
   * folding in the content rather than just its presence costs nothing and
   * means the cache key stays correct even if that ever changes.
   */
  customAssetsBytes?: string;
}

export function cacheKey(parts: CacheKeyParts): string {
  return sha256(
    [
      parts.layoutBytes,
      parts.upstreamCommit ?? 'no-commit',
      parts.upstreamVersion ?? 'no-version',
      `scale=${parts.scale}`,
      `format=${RENDER_FORMAT}`,
      parts.customAssetsBytes ?? 'no-custom-assets',
    // Joined with NUL, which cannot occur in any of the parts, so no
    // combination of fields can collide with a different combination.
    ].join('\u0000'),
  );
}

export class PreviewCache {
  private entries = 0;

  constructor(
    private readonly dir: string,
    private readonly maxEntries: number,
  ) {}

  get enabled(): boolean {
    return this.maxEntries > 0;
  }

  async init(): Promise<void> {
    if (!this.enabled) return;
    await fs.mkdir(this.dir, { recursive: true });
    this.entries = (await fs.readdir(this.dir)).length;
  }

  private file(key: string): string {
    return path.join(this.dir, `${key}.png`);
  }

  async get(key: string): Promise<Buffer | null> {
    if (!this.enabled) return null;
    try {
      return await fs.readFile(this.file(key));
    } catch {
      return null;
    }
  }

  async set(key: string, png: Buffer): Promise<void> {
    if (!this.enabled) return;
    // Over the ceiling, stop writing rather than evicting: previews are tiny and
    // deterministic, so a cold entry costs one render, while an eviction policy
    // costs correctness bugs. #17 sizes the volume.
    if (this.entries >= this.maxEntries) return;

    // Write-then-rename, so a crash mid-write cannot leave a truncated PNG that
    // would then be served forever as a cache hit.
    const target = this.file(key);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, png);
    await fs.rename(temporary, target);
    this.entries += 1;
  }
}
