import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { nestedAssetZip, simpleAssetZip, tinyPng } from '../test-support/assetZip.js';
import { decodeFurnitureZip } from './decode.js';

const noneTaken = () => false;

describe('decodeFurnitureZip', () => {
  it('decodes a flat manifest.json + PNG at the zip root', async () => {
    const zip = await simpleAssetZip('MY_CHAIR');
    const decoded = await decodeFurnitureZip(zip, 'My Chair', 'chairs', noneTaken);

    expect(decoded.assetId).toBe('MY_CHAIR');
    expect(decoded.requestedAssetId).toBe('MY_CHAIR');
    expect(decoded.manifest).toHaveLength(1);
    expect(decoded.manifest[0]?.id).toBe('MY_CHAIR');
    expect(decoded.sprites.MY_CHAIR).toHaveLength(16);
    expect(decoded.sprites.MY_CHAIR?.[0]).toHaveLength(16);
  });

  it("decodes pixel-art-mcp's nested assets/furniture/<ID>/manifest.json shape", async () => {
    const zip = await nestedAssetZip('MY_LAMP');
    const decoded = await decodeFurnitureZip(zip, 'My Lamp', 'decor', noneTaken);
    expect(decoded.assetId).toBe('MY_LAMP');
    expect(decoded.sprites.MY_LAMP).toBeDefined();
  });

  it('auto-suffixes a colliding id rather than rejecting the upload', async () => {
    const zip = await simpleAssetZip('MY_CHAIR');
    const isTaken = (id: string) => id === 'MY_CHAIR';
    const decoded = await decodeFurnitureZip(zip, 'My Chair', 'chairs', isTaken);

    expect(decoded.assetId).toBe('MY_CHAIR_2');
    expect(decoded.requestedAssetId).toBe('MY_CHAIR');
    expect(decoded.manifest[0]?.id).toBe('MY_CHAIR_2');
    expect(decoded.sprites.MY_CHAIR_2).toBeDefined();
  });

  it('tries successive suffixes until one is free', async () => {
    const zip = await simpleAssetZip('MY_CHAIR');
    const taken = new Set(['MY_CHAIR', 'MY_CHAIR_2', 'MY_CHAIR_3']);
    const decoded = await decodeFurnitureZip(zip, 'My Chair', 'chairs', (id) => taken.has(id));
    expect(decoded.assetId).toBe('MY_CHAIR_4');
  });

  it('rejects a PNG whose actual dimensions do not match the manifest', async () => {
    const zip = await simpleAssetZip('MISMATCHED', { width: 16, height: 16, pngWidth: 32, pngHeight: 32 });
    await expect(decodeFurnitureZip(zip, 'Mismatched', 'misc', noneTaken)).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it('rejects a zip with no manifest.json', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'oops');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(decodeFurnitureZip(buffer, 'Nothing', 'misc', noneTaken)).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it('rejects a malformed manifest (bad id, missing fields)', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ id: 'lowercase-not-allowed', type: 'asset' }));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const result = decodeFurnitureZip(buffer, 'Bad', 'misc', noneTaken);
    await expect(result).rejects.toMatchObject({ statusCode: 422 });
    await result.catch((error: unknown) => {
      expect((error as { issues?: unknown[] }).issues?.length).toBeGreaterThan(0);
    });
  });

  it('rejects a manifest referencing a file the zip does not contain', async () => {
    const zip = new JSZip();
    zip.file(
      'manifest.json',
      JSON.stringify({
        id: 'MISSING_FILE',
        name: 'Missing',
        category: 'misc',
        type: 'asset',
        file: 'nope.png',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
      }),
    );
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(decodeFurnitureZip(buffer, 'Missing', 'misc', noneTaken)).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it('flattens a rotation group into one variant per member, renamed together on collision', async () => {
    const zip = new JSZip();
    zip.file(
      'manifest.json',
      JSON.stringify({
        id: 'MY_DESK',
        name: 'My Desk',
        category: 'desks',
        type: 'group',
        groupType: 'rotation',
        rotationScheme: '2-way',
        canPlaceOnWalls: false,
        canPlaceOnSurfaces: false,
        backgroundTiles: 1,
        members: [
          {
            type: 'asset',
            id: 'MY_DESK_FRONT',
            file: 'front.png',
            width: 32,
            height: 32,
            footprintW: 2,
            footprintH: 2,
            orientation: 'front',
          },
          {
            type: 'asset',
            id: 'MY_DESK_SIDE',
            file: 'side.png',
            width: 16,
            height: 32,
            footprintW: 1,
            footprintH: 2,
            orientation: 'side',
          },
        ],
      }),
    );
    zip.file('front.png', tinyPng(32, 32));
    zip.file('side.png', tinyPng(16, 32));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const decoded = await decodeFurnitureZip(buffer, 'My Desk', 'desks', (id) => id === 'MY_DESK');

    expect(decoded.assetId).toBe('MY_DESK_2');
    const ids = decoded.manifest.map((m) => m.id).sort();
    expect(ids).toEqual(['MY_DESK_2_FRONT', 'MY_DESK_2_SIDE']);
    expect(decoded.sprites.MY_DESK_2_FRONT).toBeDefined();
    expect(decoded.sprites.MY_DESK_2_SIDE).toBeDefined();
  });
});
