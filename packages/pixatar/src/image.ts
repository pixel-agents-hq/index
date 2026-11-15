/** Straight (non-premultiplied) 8-bit RGBA pixels, row by row: what an ImageData holds. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export const blankImage = (width: number, height: number): RgbaImage => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4),
});

const hexRgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new TypeError(`Not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};

/** Fill an image with an opaque colour. */
export function fill(image: RgbaImage, hex: string): void {
  const [r, g, b] = hexRgb(hex);
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = r;
    image.data[i + 1] = g;
    image.data[i + 2] = b;
    image.data[i + 3] = 255;
  }
}

/**
 * Draw `src` (its sx, sy, w, h region; pixels outside it are empty) onto `dst` at dx, dy,
 * `scale` destination pixels per source pixel, alpha-blended (source over).
 */
export function blit(
  src: RgbaImage,
  sx: number,
  sy: number,
  w: number,
  h: number,
  dst: RgbaImage,
  dx = 0,
  dy = 0,
  scale = 1,
): void {
  for (let y = 0; y < h; y++) {
    const yy = sy + y;
    if (yy < 0 || yy >= src.height) continue;
    for (let x = 0; x < w; x++) {
      const xx = sx + x;
      if (xx < 0 || xx >= src.width) continue;
      const s = (yy * src.width + xx) * 4;
      const a = src.data[s + 3] / 255;
      if (a === 0) continue;
      for (let py = 0; py < scale; py++) {
        for (let px = 0; px < scale; px++) {
          const tx = dx + x * scale + px;
          const ty = dy + y * scale + py;
          if (tx < 0 || ty < 0 || tx >= dst.width || ty >= dst.height) continue;
          const d = (ty * dst.width + tx) * 4;
          const da = dst.data[d + 3] / 255;
          const oa = a + da * (1 - a);
          for (let c = 0; c < 3; c++) {
            dst.data[d + c] = Math.round((src.data[s + c] * a + dst.data[d + c] * da * (1 - a)) / oa);
          }
          dst.data[d + 3] = Math.round(oa * 255);
        }
      }
    }
  }
}
