import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { petZip, tinyPng } from '../test-support/assetZip.js';
import { decodePetZip } from './decodePet.js';

const noneTaken = () => false;

describe('decodePetZip', () => {
  it('decodes a manifest.json + 96×96 PNG at <id>/', async () => {
    const zip = await petZip('MY_PET', 'Bubbles');
    const decoded = await decodePetZip(zip, noneTaken);

    expect(decoded.assetKind).toBe('pet');
    expect(decoded.assetId).toBe('MY_PET');
    expect(decoded.requestedAssetId).toBe('MY_PET');
    expect(decoded.category).toBeNull();
    expect(decoded.manifest).toHaveLength(1);
    expect(decoded.manifest[0]).toMatchObject({ id: 'MY_PET', name: 'Bubbles', width: 96, height: 96 });

    const frames = decoded.sprites.MY_PET;
    expect(frames?.walkDown).toHaveLength(3);
    expect(frames?.idleDown).toHaveLength(3);
    expect(frames?.walkUp).toHaveLength(3);
    expect(frames?.idleUp).toHaveLength(3);
    expect(frames?.walkRight).toHaveLength(3);
    expect(frames?.walkDown[0]).toHaveLength(32);
    expect(frames?.walkDown[0]?.[0]).toHaveLength(16);
    expect(frames?.walkRight[0]?.[0]).toHaveLength(32);
  });

  it('auto-suffixes a colliding id rather than rejecting the upload', async () => {
    const zip = await petZip('MY_PET', 'Bubbles');
    const isTaken = (id: string) => id === 'MY_PET';
    const decoded = await decodePetZip(zip, isTaken);
    expect(decoded.assetId).toBe('MY_PET_2');
    expect(decoded.requestedAssetId).toBe('MY_PET');
  });

  it('rejects a zip with no manifest.json', async () => {
    const zip = new JSZip();
    zip.file('MY_PET/pet.png', tinyPng(96, 96));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(decodePetZip(buffer, noneTaken)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects a manifest with an invalid id', async () => {
    const zip = await petZip('lowercase-not-allowed', 'Bubbles');
    await expect(decodePetZip(zip, noneTaken)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects a manifest missing name', async () => {
    const zip = new JSZip();
    zip.file('MY_PET/manifest.json', JSON.stringify({ id: 'MY_PET' }));
    zip.file('MY_PET/pet.png', tinyPng(96, 96));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(decodePetZip(buffer, noneTaken)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects a PNG whose dimensions are not 96×96', async () => {
    const zip = await petZip('MY_PET', 'Bubbles', { pngWidth: 16, pngHeight: 16 });
    await expect(decodePetZip(zip, noneTaken)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects more than one PNG alongside the manifest', async () => {
    const zip = new JSZip();
    zip.file('MY_PET/manifest.json', JSON.stringify({ id: 'MY_PET', name: 'Bubbles' }));
    zip.file('MY_PET/pet.png', tinyPng(96, 96));
    zip.file('MY_PET/extra.png', tinyPng(96, 96));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(decodePetZip(buffer, noneTaken)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects a pet PNG over 512 KiB, even though it is well under the whole-zip cap (#107)', async () => {
    // A real 96x96 PNG compresses to well under 512 KiB — pad the raw PNG
    // buffer itself with trailing bytes (harmless after the IEND chunk) to
    // push it over the cap without needing an actually-huge image.
    const zip = new JSZip();
    zip.file('MY_PET/manifest.json', JSON.stringify({ id: 'MY_PET', name: 'Bubbles' }));
    const oversizedPng = Buffer.concat([tinyPng(96, 96), Buffer.alloc(513 * 1024)]);
    zip.file('MY_PET/pet.png', oversizedPng);
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(decodePetZip(buffer, noneTaken)).rejects.toMatchObject({ statusCode: 422 });
  });
});
