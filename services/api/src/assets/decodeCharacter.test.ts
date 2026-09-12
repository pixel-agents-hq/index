import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { characterZip, tinyPng } from '../test-support/assetZip.js';
import { decodeCharacterZip } from './decodeCharacter.js';

const noneTaken = () => false;

describe('decodeCharacterZip', () => {
  it('decodes a manifest.json + 112×96 PNG', async () => {
    const zip = await characterZip('MY_CHARACTER', 'My Character');
    const decoded = await decodeCharacterZip(zip, noneTaken);

    expect(decoded.assetKind).toBe('character');
    expect(decoded.assetId).toBe('MY_CHARACTER');
    expect(decoded.requestedAssetId).toBe('MY_CHARACTER');
    expect(decoded.category).toBeNull();
    expect(decoded.manifest).toHaveLength(1);
    expect(decoded.manifest[0]).toMatchObject({
      id: 'MY_CHARACTER',
      name: 'My Character',
      width: 112,
      height: 96,
    });

    const frames = decoded.sprites.MY_CHARACTER;
    expect(frames?.down).toHaveLength(7);
    expect(frames?.up).toHaveLength(7);
    expect(frames?.right).toHaveLength(7);
    expect(frames?.down[0]).toHaveLength(32);
    expect(frames?.down[0]?.[0]).toHaveLength(16);
  });

  it('auto-suffixes a colliding id rather than rejecting the upload', async () => {
    const zip = await characterZip('MY_CHARACTER', 'My Character');
    const isTaken = (id: string) => id === 'MY_CHARACTER';
    const decoded = await decodeCharacterZip(zip, isTaken);
    expect(decoded.assetId).toBe('MY_CHARACTER_2');
    expect(decoded.requestedAssetId).toBe('MY_CHARACTER');
  });

  it('rejects a zip with no manifest.json', async () => {
    const zip = new JSZip();
    zip.file('char.png', tinyPng(112, 96));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(decodeCharacterZip(buffer, noneTaken)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects a manifest with an invalid id', async () => {
    const zip = await characterZip('lowercase-not-allowed', 'My Character');
    await expect(decodeCharacterZip(zip, noneTaken)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects a manifest missing name', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ id: 'MY_CHARACTER' }));
    zip.file('char.png', tinyPng(112, 96));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(decodeCharacterZip(buffer, noneTaken)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects a zip with no PNG', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ id: 'MY_CHARACTER', name: 'My Character' }));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(decodeCharacterZip(buffer, noneTaken)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects a zip with more than one PNG', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ id: 'MY_CHARACTER', name: 'My Character' }));
    zip.file('a.png', tinyPng(112, 96));
    zip.file('b.png', tinyPng(112, 96));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(decodeCharacterZip(buffer, noneTaken)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects a PNG whose dimensions are not 112×96', async () => {
    const zip = await characterZip('MY_CHARACTER', 'My Character', { pngWidth: 16, pngHeight: 16 });
    await expect(decodeCharacterZip(zip, noneTaken)).rejects.toMatchObject({ statusCode: 422 });
  });
});
