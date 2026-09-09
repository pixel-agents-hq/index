import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { characterZip, tinyPng } from '../test-support/assetZip.js';
import { decodeCharacterZip } from './decodeCharacter.js';

const noneTaken = () => false;

describe('decodeCharacterZip', () => {
  it('decodes a single 112×96 PNG with no manifest', async () => {
    const zip = await characterZip();
    const decoded = await decodeCharacterZip(zip, 'My Character', noneTaken);

    expect(decoded.assetKind).toBe('character');
    expect(decoded.category).toBeNull();
    expect(decoded.manifest).toHaveLength(1);
    expect(decoded.manifest[0]).toMatchObject({ name: 'My Character', width: 112, height: 96 });

    const frames = decoded.sprites[decoded.assetId];
    expect(frames?.down).toHaveLength(7);
    expect(frames?.up).toHaveLength(7);
    expect(frames?.right).toHaveLength(7);
    expect(frames?.down[0]).toHaveLength(32);
    expect(frames?.down[0]?.[0]).toHaveLength(16);
  });

  it('derives a stable id from the display name', async () => {
    const zip = await characterZip();
    const decoded = await decodeCharacterZip(zip, 'My Cool Character!', noneTaken);
    expect(decoded.assetId).toBe('MY_COOL_CHARACTER');
    expect(decoded.requestedAssetId).toBe('MY_COOL_CHARACTER');
  });

  it('auto-suffixes a colliding id rather than rejecting the upload', async () => {
    const zip = await characterZip();
    const isTaken = (id: string) => id === 'MY_CHARACTER';
    const decoded = await decodeCharacterZip(zip, 'My Character', isTaken);
    expect(decoded.assetId).toBe('MY_CHARACTER_2');
    expect(decoded.requestedAssetId).toBe('MY_CHARACTER');
  });

  it('rejects a zip that also includes a manifest.json', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ id: 'X' }));
    zip.file('char.png', tinyPng(112, 96));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(decodeCharacterZip(buffer, 'Bad', noneTaken)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects a zip with no PNG', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'oops');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(decodeCharacterZip(buffer, 'Nothing', noneTaken)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects a zip with more than one PNG', async () => {
    const zip = new JSZip();
    zip.file('a.png', tinyPng(112, 96));
    zip.file('b.png', tinyPng(112, 96));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(decodeCharacterZip(buffer, 'Two', noneTaken)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects a PNG whose dimensions are not 112×96', async () => {
    const zip = await characterZip({ pngWidth: 16, pngHeight: 16 });
    await expect(decodeCharacterZip(zip, 'Wrong Size', noneTaken)).rejects.toMatchObject({ statusCode: 422 });
  });
});
