/**
 * The JSON Schemas, loaded once.
 *
 * They live outside `src/` because they are a published artifact — the API
 * serves them and contributors reference them — so they must not be reshaped by
 * a TypeScript build. `../schema` resolves identically from `src/` under vitest
 * and from `dist/` after `tsc`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../schema');

const read = (file: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf-8')) as Record<string, unknown>;

export const layoutSchema = read('layout.schema.json');
export const metaSchema = read('meta.schema.json');
export const customAssetFurnitureManifestSchema = read('custom-asset-furniture-manifest.schema.json');
export const customAssetPetManifestSchema = read('custom-asset-pet-manifest.schema.json');
export { SCHEMA_DIR };
