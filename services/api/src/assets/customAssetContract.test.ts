/**
 * Cross-checks docs/custom-asset-zip-contract.md's published JSON Schemas
 * (#107) against this repo's own fixture builders
 * (`test-support/assetZip.ts`) — the same builders `decode*.test.ts` and
 * `submit.test.ts` already exercise against the real decode logic. If a
 * fixture that decode.ts/decodePet.ts genuinely accepts ever stopped
 * validating against these schemas (or vice versa), that's exactly the
 * producer/consumer drift #107 exists to catch before pixel-art-mcp does.
 */

import {
  customAssetFurnitureManifestSchema,
  customAssetPetManifestSchema,
  furnitureCategories,
  withFormats,
} from '@pixel-index/layout-core';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { characterZip, nestedAssetZip, petZip, simpleAssetZip } from '../test-support/assetZip.js';
import { CHARACTER_HEIGHT, CHARACTER_WIDTH } from './decodeCharacter.js';
import { PET_HEIGHT, PET_WIDTH } from './decodePet.js';

const ajv = withFormats(new Ajv2020({ allErrors: true, strict: false }));
const validateFurnitureManifest: ValidateFunction = ajv.compile(customAssetFurnitureManifestSchema);
const validatePetManifest: ValidateFunction = ajv.compile(customAssetPetManifestSchema);

/** Finds and parses the one manifest.json in a zip buffer, or undefined if there is none. */
async function readManifest(zipBuffer: Buffer): Promise<unknown> {
  const zip = await JSZip.loadAsync(zipBuffer);
  const path = Object.keys(zip.files).find((name) => name.split('/').pop() === 'manifest.json');
  if (path === undefined) return undefined;
  const entry = zip.file(path);
  return entry ? (JSON.parse(await entry.async('text')) as unknown) : undefined;
}

describe('custom-asset-furniture-manifest.schema.json', () => {
  it('accepts simpleAssetZip (flat root-level manifest.json + PNG)', async () => {
    const manifest = await readManifest(await simpleAssetZip('MY_CHAIR'));
    const ok = validateFurnitureManifest(manifest);
    expect(ok, JSON.stringify(validateFurnitureManifest.errors)).toBe(true);
  });

  it("accepts nestedAssetZip (pixel-art-mcp's own assets/furniture/<ID>/manifest.json layout)", async () => {
    const manifest = await readManifest(await nestedAssetZip('MY_LAMP'));
    const ok = validateFurnitureManifest(manifest);
    expect(ok, JSON.stringify(validateFurnitureManifest.errors)).toBe(true);
  });

  it('accepts a group manifest (rotation/state/animation members), not just a flat asset', () => {
    const manifest = {
      id: 'MY_DESK',
      name: 'My Desk',
      category: 'desks',
      type: 'group',
      groupType: 'rotation',
      members: [
        { type: 'asset', id: 'MY_DESK_FRONT', file: 'front.png', width: 32, height: 32, footprintW: 2, footprintH: 1 },
        { type: 'asset', id: 'MY_DESK_BACK', file: 'back.png', width: 32, height: 32, footprintW: 2, footprintH: 1 },
      ],
    };
    const ok = validateFurnitureManifest(manifest);
    expect(ok, JSON.stringify(validateFurnitureManifest.errors)).toBe(true);
  });

  it('rejects an asset-type manifest missing a required PNG dimension', () => {
    const manifest = {
      id: 'MY_CHAIR',
      name: 'My Chair',
      category: 'chairs',
      type: 'asset',
      file: 'chair.png',
      width: 16,
      // height missing
      footprintW: 1,
      footprintH: 1,
    };
    expect(validateFurnitureManifest(manifest)).toBe(false);
  });

  it('rejects an unknown category', () => {
    const manifest = {
      id: 'MY_CHAIR',
      name: 'My Chair',
      category: 'seating', // not one of the 7 upstream-parity values
      type: 'asset',
      file: 'chair.png',
      width: 16,
      height: 16,
      footprintW: 1,
      footprintH: 1,
    };
    expect(validateFurnitureManifest(manifest)).toBe(false);
  });

  it("category enum matches furnitureCategories() — catches a hand-edited-but-not-regenerated schema file", () => {
    // The committed schema is generated (tools/generate-furniture-categories-
    // schema.mjs) from the pinned vendor's real bundled manifests. This is
    // the defense-in-depth half of that guarantee: CI's `--check` step
    // catches drift at push time; this catches it any time `npm test` runs,
    // including locally before a commit.
    const schema = customAssetFurnitureManifestSchema as {
      properties: { category: { enum: string[] } };
    };
    expect(schema.properties.category.enum).toEqual(furnitureCategories());
  });
});

describe('custom-asset-pet-manifest.schema.json', () => {
  it('accepts petZip (<id>/{manifest.json, pet.png})', async () => {
    const manifest = await readManifest(await petZip('MY_PET', 'Bubbles'));
    const ok = validatePetManifest(manifest);
    expect(ok, JSON.stringify(validatePetManifest.errors)).toBe(true);
  });

  it('rejects a lowercase id', () => {
    expect(validatePetManifest({ id: 'my_pet', name: 'Bubbles' })).toBe(false);
  });

  it('rejects a missing name', () => {
    expect(validatePetManifest({ id: 'MY_PET' })).toBe(false);
  });
});

describe('character zip (no manifest.json — PNG-only rule, see docs/custom-asset-zip-contract.md)', () => {
  it('has no manifest.json and exactly one 112x96 PNG', async () => {
    const zipBuffer = await characterZip();
    const zip = await JSZip.loadAsync(zipBuffer);
    const names = Object.keys(zip.files);

    expect(names.some((name) => name.split('/').pop() === 'manifest.json')).toBe(false);

    const pngPaths = names.filter((name) => name.toLowerCase().endsWith('.png'));
    expect(pngPaths).toHaveLength(1);
    const pngPath = pngPaths[0];
    if (pngPath === undefined) throw new Error('unreachable');
    const entry = zip.file(pngPath);
    if (!entry) throw new Error('unreachable');

    const png = PNG.sync.read(await entry.async('nodebuffer'));
    expect(png.width).toBe(CHARACTER_WIDTH);
    expect(png.height).toBe(CHARACTER_HEIGHT);
  });
});

describe('pet PNG dimensions match the documented frame grid', () => {
  it('petZip produces a 96x96 PNG', async () => {
    const zipBuffer = await petZip('MY_PET', 'Bubbles');
    const zip = await JSZip.loadAsync(zipBuffer);
    const pngPath = Object.keys(zip.files).find((name) => name.toLowerCase().endsWith('.png'));
    if (pngPath === undefined) throw new Error('unreachable');
    const entry = zip.file(pngPath);
    if (!entry) throw new Error('unreachable');

    const png = PNG.sync.read(await entry.async('nodebuffer'));
    expect(png.width).toBe(PET_WIDTH);
    expect(png.height).toBe(PET_HEIGHT);
  });
});
