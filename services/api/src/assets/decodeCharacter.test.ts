import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { characterZip, tinyPng } from '../test-support/assetZip.js';
import { currentCharacterFrames, decodeCharacterZip, encodeCharacterSheet } from './decodeCharacter.js';

const noneTaken = () => false;

/** A 112×96 legacy sheet whose every frame column is its own colour, darker on its right half. */
function legacySheet(): Buffer {
  const png = new PNG({ width: 112, height: 96 });
  for (let y = 0; y < 96; y++) {
    for (let x = 0; x < 112; x++) {
      const i = (y * 112 + x) * 4;
      png.data[i] = Math.floor(x / 16) * 30;
      png.data[i + 1] = x % 16 < 8 ? 200 : 100;
      png.data[i + 2] = Math.floor(y / 32) * 60;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

async function legacyZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ id: 'OLD_HERO', name: 'Old Hero' }));
  zip.file('char.png', legacySheet());
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('decodeCharacterZip', () => {
  it('decodes a manifest.json + 128×96 PNG', async () => {
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
      width: 128,
      height: 96,
    });

    const frames = decoded.sprites.MY_CHARACTER;
    expect(frames?.down).toHaveLength(8);
    expect(frames?.up).toHaveLength(8);
    expect(frames?.right).toHaveLength(8);
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

  it('widens a legacy 112×96 sheet with the seated frame, derived from the typing frames as upstream does', async () => {
    const decoded = await decodeCharacterZip(await legacyZip(), noneTaken);
    expect(decoded.manifest[0]).toMatchObject({ width: 128, height: 96 });
    const frames = decoded.sprites.OLD_HERO;
    if (!frames) throw new Error('no frames');
    for (const dir of ['down', 'up', 'right'] as const) expect(frames[dir]).toHaveLength(8);
    // Front and back: left half from type2 (column 4), right half from type1 (column 3).
    for (const dir of ['down', 'up'] as const) {
      expect(frames[dir][7]?.[0]?.slice(0, 8)).toEqual(frames[dir][4]?.[0]?.slice(0, 8));
      expect(frames[dir][7]?.[0]?.slice(8)).toEqual(frames[dir][3]?.[0]?.slice(8));
    }
    // Side-on: all of type1.
    expect(frames.right[7]).toEqual(frames.right[3]);
  });

  it('widens 7-frame rows stored before the seated frame, and leaves 8-frame rows alone', async () => {
    const decoded = await decodeCharacterZip(await legacyZip(), noneTaken);
    const current = decoded.sprites.OLD_HERO;
    if (!current) throw new Error('no frames');
    const stored = { down: current.down.slice(0, 7), up: current.up.slice(0, 7), right: current.right.slice(0, 7) };
    expect(currentCharacterFrames(stored)).toEqual(current);
    expect(currentCharacterFrames(current).down).toBe(current.down);
  });

  it('exports a 128×96 sheet that decodes back to the same frames, even from stored 7-frame rows', async () => {
    const decoded = await decodeCharacterZip(await legacyZip(), noneTaken);
    const current = decoded.sprites.OLD_HERO;
    if (!current) throw new Error('no frames');
    const stored = { down: current.down.slice(0, 7), up: current.up.slice(0, 7), right: current.right.slice(0, 7) };
    const sheet = encodeCharacterSheet(stored);
    const png = PNG.sync.read(sheet);
    expect([png.width, png.height]).toEqual([128, 96]);
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ id: 'OLD_HERO', name: 'Old Hero' }));
    zip.file('char.png', sheet);
    const again = await decodeCharacterZip(await zip.generateAsync({ type: 'nodebuffer' }), noneTaken);
    expect(again.sprites.OLD_HERO).toEqual(current);
  });

  it('rejects a PNG whose dimensions are neither 128×96 nor 112×96', async () => {
    const zip = await characterZip('MY_CHARACTER', 'My Character', { pngWidth: 16, pngHeight: 16 });
    await expect(decodeCharacterZip(zip, noneTaken)).rejects.toMatchObject({ statusCode: 422 });
  });
});
