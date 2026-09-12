/** Builds fixture upload zips for the custom-assets test suites. */

import JSZip from 'jszip';
import { PNG } from 'pngjs';

/** A tiny opaque PNG of the given size — pixel content is irrelevant to these tests. */
export function tinyPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = 255;
    png.data[i * 4 + 1] = 0;
    png.data[i * 4 + 2] = 0;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** A single-asset manifest + matching PNG, zipped at the root (the flat, hand-crafted shape). */
export async function simpleAssetZip(
  id: string,
  overrides: {
    width?: number;
    height?: number;
    pngWidth?: number;
    pngHeight?: number;
    name?: string;
    category?: string;
  } = {},
): Promise<Buffer> {
  const width = overrides.width ?? 16;
  const height = overrides.height ?? 16;
  const zip = new JSZip();
  zip.file(
    'manifest.json',
    JSON.stringify({
      id,
      name: overrides.name ?? 'Test Chair',
      category: overrides.category ?? 'chairs',
      type: 'asset',
      file: `${id}.png`,
      width,
      height,
      footprintW: 1,
      footprintH: 1,
      canPlaceOnWalls: false,
      canPlaceOnSurfaces: false,
      backgroundTiles: 0,
    }),
  );
  zip.file(`${id}.png`, tinyPng(overrides.pngWidth ?? width, overrides.pngHeight ?? height));
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** A custom-character zip (#105 follow-up): `manifest.json` (`{id, name}`) + a 112×96 PNG, mirroring `petZip`. */
export async function characterZip(
  id = 'TEST_HERO',
  name = 'Test Hero',
  overrides: { pngWidth?: number; pngHeight?: number; includeManifest?: boolean } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  if (overrides.includeManifest !== false) {
    zip.file('manifest.json', JSON.stringify({ id, name }));
  }
  zip.file('char.png', tinyPng(overrides.pngWidth ?? 112, overrides.pngHeight ?? 96));
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** A custom-pet zip (#105): `<id>/{manifest.json, pet.png}`, manifest is just `{id, name}`. */
export async function petZip(
  id: string,
  name = 'Test Pet',
  overrides: { pngWidth?: number; pngHeight?: number; includeManifest?: boolean } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  const dir = id;
  if (overrides.includeManifest !== false) {
    zip.file(`${dir}/manifest.json`, JSON.stringify({ id, name }));
  }
  zip.file(`${dir}/pet.png`, tinyPng(overrides.pngWidth ?? 96, overrides.pngHeight ?? 96));
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** pixel-art-mcp's own nested `assets/furniture/<ID>/manifest.json` zip shape. */
export async function nestedAssetZip(id: string): Promise<Buffer> {
  const zip = new JSZip();
  const dir = `assets/furniture/${id}`;
  zip.file(
    `${dir}/manifest.json`,
    JSON.stringify({
      id,
      name: 'Test Lamp',
      category: 'decor',
      type: 'asset',
      file: `${id}.png`,
      width: 16,
      height: 16,
      footprintW: 1,
      footprintH: 1,
      canPlaceOnWalls: false,
      canPlaceOnSurfaces: false,
      backgroundTiles: 0,
    }),
  );
  zip.file(`${dir}/${id}.png`, tinyPng(16, 16));
  return zip.generateAsync({ type: 'nodebuffer' });
}
