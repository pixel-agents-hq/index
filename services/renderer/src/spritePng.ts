/**
 * PNG -> sprite-data decode, a hand-kept local copy of pixel-agents' own
 * `core/src/assets/pngDecoder.ts` — same reasoning as `services/api`'s
 * `assets/manifest.ts`: this package's own strictness/build setup can't
 * reach across into the vendor submodule, so the pixel encoding (`''` =
 * transparent, `#RRGGBB` opaque, `#RRGGBBAA` semi-transparent) is
 * reproduced here rather than imported.
 */

import { PNG } from 'pngjs';

export function decodeSpritePng(buffer: Buffer, width: number, height: number): string[][] {
  const png = PNG.sync.read(buffer);
  const sprite: string[][] = [];
  for (let y = 0; y < height; y++) {
    const row: string[] = [];
    for (let x = 0; x < width; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i] ?? 0;
      const g = png.data[i + 1] ?? 0;
      const b = png.data[i + 2] ?? 0;
      const a = png.data[i + 3] ?? 0;
      row.push(toHex(r, g, b, a));
    }
    sprite.push(row);
  }
  return sprite;
}

function toHex(r: number, g: number, b: number, a: number): string {
  if (a < 2) return '';
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return a < 255 ? `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}` : `#${hex(r)}${hex(g)}${hex(b)}`;
}
