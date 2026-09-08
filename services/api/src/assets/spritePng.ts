/** The reverse of `decode.ts`'s pixel decoding — sprite data back to a displayable PNG. */

import { PNG } from 'pngjs';

function hexToRgba(hex: string): [number, number, number, number] {
  if (hex === '') return [0, 0, 0, 0];
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const a = hex.length > 7 ? parseInt(hex.slice(7, 9), 16) : 255;
  return [r, g, b, a];
}

export function encodeSpritePng(sprite: string[][]): Buffer {
  const height = sprite.length;
  const width = sprite[0]?.length ?? 0;
  const png = new PNG({ width: Math.max(1, width), height: Math.max(1, height) });

  for (let y = 0; y < height; y++) {
    const row = sprite[y] ?? [];
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = hexToRgba(row[x] ?? '');
      const i = (y * width + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = a;
    }
  }

  return PNG.sync.write(png);
}
