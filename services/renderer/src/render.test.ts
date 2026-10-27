/**
 * The crop geometry, without a browser.
 *
 * `renderGeometry()` is the whole of #71's fix that can be checked cheaply:
 * it is pure arithmetic over the layout, so the numbers a preview will be
 * cropped to are assertable here rather than only by rendering a PNG and
 * measuring it. The integration suite still checks the actual pixels.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Layout, occupiedBounds } from '@pixel-index/layout-core';
import { describe, expect, it } from 'vitest';

import { renderGeometry, unionBox } from './render.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SEED_DIR = path.join(REPO_ROOT, 'seed');

const loadSeed = (slug: string): Layout =>
  JSON.parse(fs.readFileSync(path.join(SEED_DIR, slug, 'layout.json'), 'utf-8')) as Layout;

/** One tile, in device pixels: TILE_SIZE 16 at ZOOM 2. */
const TILE_PX = 32;

/** A layout whose occupied region is a `w`×`h` block at (`col`, `row`). */
function padded(cols: number, rows: number, col: number, row: number, w: number, h: number): Layout {
  const VOID = 255;
  const FLOOR = 0;
  const tiles = new Array<number>(cols * rows).fill(VOID);
  for (let r = row; r < row + h; r += 1) {
    for (let c = col; c < col + w; c += 1) tiles[r * cols + c] = FLOOR;
  }
  return { cols, rows, tiles, furniture: [] } as unknown as Layout;
}

describe('renderGeometry (#71)', () => {
  it('sizes the viewport from the declared canvas, not the occupied region', () => {
    // Upstream centres the map using the *declared* cols/rows, so the viewport
    // has to keep spanning them or the office slides out of frame.
    const { width, height } = renderGeometry(padded(53, 46, 14, 10, 25, 27));
    expect(width).toBe((53 + 2) * TILE_PX);
    expect(height).toBe((46 + 2) * TILE_PX);
  });

  it('crops to the occupied tiles, so a padded canvas is trimmed away', () => {
    // The layout from the bug report (6e3bc6dd2e): declared 53×46, occupying
    // 25×27 at (14, 10). These are the exact numbers measured off the broken
    // preview.png that #71 was filed against.
    const { box } = renderGeometry(padded(53, 46, 14, 10, 25, 27));
    expect(box).toEqual({ minX: 480, minY: 352, maxX: 1279, maxY: 1215 });
    expect(box.maxX - box.minX + 1).toBe(25 * TILE_PX);
    expect(box.maxY - box.minY + 1).toBe(27 * TILE_PX);
  });

  it('never sizes the viewport under the upstream mobile breakpoint', () => {
    // Upstream's mobile shell starts at (max-width: 768px) and would move the
    // map; a narrow layout keeps the desktop layout by getting extra width,
    // which the centring below absorbs.
    expect(renderGeometry(padded(10, 8, 0, 0, 10, 8)).width).toBe(769);
    expect(renderGeometry(padded(21, 22, 0, 0, 21, 22)).width).toBe(769);
    expect(renderGeometry(padded(23, 22, 0, 0, 23, 22)).width).toBe((23 + 2) * TILE_PX);
  });

  it('centres a narrow layout in the widened viewport', () => {
    // floor((769 - 10 * 32) / 2) = 224, exactly as upstream's renderOffice()
    // floors it, so the crop still lands on the tiles.
    const { box } = renderGeometry(padded(10, 8, 0, 0, 10, 8));
    expect(box.minX).toBe(224);
    expect(box.maxX).toBe(224 + 10 * TILE_PX - 1);
  });

  it('crops nothing when the layout occupies its whole canvas', () => {
    const { width, height, box } = renderGeometry(padded(30, 8, 0, 0, 30, 8));
    // One margin tile on each side, and that margin is what gets trimmed.
    expect(box.minX).toBe(TILE_PX);
    expect(box.minY).toBe(TILE_PX);
    expect(box.maxX).toBe(width - TILE_PX - 1);
    expect(box.maxY).toBe(height - TILE_PX - 1);
  });

  it('falls back to the full canvas for an entirely-VOID layout', () => {
    // occupiedBounds() reports the declared canvas when nothing is occupied;
    // the crop must not collapse to zero or go negative.
    const { box } = renderGeometry(padded(6, 6, 0, 0, 0, 0));
    expect(box.maxX - box.minX + 1).toBe(6 * TILE_PX);
    expect(box.maxY - box.minY + 1).toBe(6 * TILE_PX);
  });

  // The #55 seeds: three share a declared canvas but not a footprint, which is
  // exactly the case a viewport-sized render got wrong. A crop that ignored
  // visibleCols/visibleRows would produce identical dimensions for all three.
  it.each([
    ['default', 20, 11],
    ['four-rooms', 20, 21],
    ['severance-office', 20, 12],
    ['blue-office', 25, 12],
  ])('%s crops to its %d×%d footprint', (slug, visibleCols, visibleRows) => {
    const layout = loadSeed(slug);
    const { box } = renderGeometry(layout);
    expect(box.maxX - box.minX + 1).toBe(visibleCols * TILE_PX);
    expect(box.maxY - box.minY + 1).toBe(visibleRows * TILE_PX);
  });

  it('agrees with layout-core rather than re-deriving the bounds', () => {
    // The point of #71's fix: one definition of "visible", shared. If these
    // ever disagree, the preview and the visibleCols/visibleRows stat beside
    // it in the gallery are describing different pictures.
    for (const slug of ['default', 'four-rooms', 'severance-office', 'blue-office']) {
      const layout = loadSeed(slug);
      const bounds = occupiedBounds(layout);
      const { box } = renderGeometry(layout);
      expect(box.maxX - box.minX + 1).toBe((bounds.maxCol - bounds.minCol + 1) * TILE_PX);
      expect(box.maxY - box.minY + 1).toBe((bounds.maxRow - bounds.minRow + 1) * TILE_PX);
    }
  });

  it('keeps the crop inside the viewport', () => {
    for (const slug of ['default', 'four-rooms', 'severance-office', 'blue-office']) {
      const { width, height, box } = renderGeometry(loadSeed(slug));
      expect(box.minX).toBeGreaterThanOrEqual(0);
      expect(box.minY).toBeGreaterThanOrEqual(0);
      expect(box.maxX).toBeLessThan(width);
      expect(box.maxY).toBeLessThan(height);
    }
  });
});

describe('unionBox (#71)', () => {
  const tiles = { minX: 100, minY: 100, maxX: 200, maxY: 200 };

  it('keeps the tile box when nothing was painted', () => {
    // The scan can fail to find anything; the layout's own bounds still stand.
    expect(unionBox(tiles, null)).toEqual(tiles);
  });

  it('grows upward for a wall sprite hanging above its tile', () => {
    // The case that made this necessary: `wallTiles.ts` anchors a wall sprite
    // at the bottom of its tile, so a two-tile-tall back wall paints a whole
    // tile above the topmost non-VOID row. Cropping to the tiles decapitates it.
    expect(unionBox(tiles, { ...tiles, minY: 68 })).toEqual({ ...tiles, minY: 68 });
  });

  it('never crops inside the tile box', () => {
    // A half-painted frame must not be able to shrink the crop — the office
    // would come out truncated, and truncated looks deliberate.
    expect(unionBox(tiles, { minX: 150, minY: 150, maxX: 160, maxY: 160 })).toEqual(tiles);
  });
});
