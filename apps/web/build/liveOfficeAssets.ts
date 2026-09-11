import * as fs from 'node:fs';
import * as path from 'node:path';

import { furnitureCategories } from '@pixel-index/layout-core';
import type { Plugin, ResolvedConfig } from 'vite';

import { buildFurnitureCatalog } from '../../../vendor/pixel-agents/core/src/assets/build.ts';
import {
  decodeAllCarpets,
  decodeAllCharacters,
  decodeAllFloors,
  decodeAllFurniture,
  decodeAllWalls,
} from '../../../vendor/pixel-agents/core/src/assets/loader.ts';
import { decodePetPng } from '../../../vendor/pixel-agents/core/src/assets/pngDecoder.ts';
import type {
  PetManifest,
  PetSpriteFrames,
} from '../../../vendor/pixel-agents/core/src/assets/types.ts';

const ASSET_FILENAMES = [
  'characters.json',
  'floors.json',
  'walls.json',
  'carpets.json',
  'furniture-catalog.json',
  'furniture.json',
  'furniture-categories.json',
  'pets.json',
] as const;

type AssetFilename = (typeof ASSET_FILENAMES)[number];
type GeneratedAssets = Record<AssetFilename, string>;

interface PetAssets {
  pets: PetSpriteFrames[];
  names: string[];
}

function loadPets(assetsDir: string): PetAssets {
  const petsDir = path.join(assetsDir, 'pets');
  if (!fs.existsSync(petsDir)) return { pets: [], names: [] };

  const pets: PetSpriteFrames[] = [];
  const names: string[] = [];
  const entries = fs
    .readdirSync(petsDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(petsDir, entry.name);
    const manifestPath = path.join(directory, 'manifest.json');
    const pngPath = path.join(directory, 'pet.png');
    if (!fs.existsSync(manifestPath) || !fs.existsSync(pngPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<PetManifest>;
    if (!manifest.id || !manifest.name) continue;
    pets.push(decodePetPng(fs.readFileSync(pngPath)));
    names.push(manifest.name);
  }

  return { pets, names };
}

function generateAssets(assetsDir: string, upstreamRoot: string): GeneratedAssets {
  const catalog = buildFurnitureCatalog(assetsDir);
  const pets = loadPets(assetsDir);
  return {
    'characters.json': JSON.stringify(decodeAllCharacters(assetsDir)),
    'floors.json': JSON.stringify(decodeAllFloors(assetsDir)),
    'walls.json': JSON.stringify(decodeAllWalls(assetsDir)),
    'carpets.json': JSON.stringify(decodeAllCarpets(assetsDir)),
    'furniture-catalog.json': JSON.stringify(catalog),
    'furniture.json': JSON.stringify(decodeAllFurniture(assetsDir, catalog)),
    // Same source apps/web's category filter/upload dropdowns need to stay
    // in sync with — derived from the pinned vendor's real bundled
    // manifests (@pixel-index/layout-core), not a hand-typed list.
    'furniture-categories.json': JSON.stringify(furnitureCategories(upstreamRoot)),
    'pets.json': JSON.stringify(pets),
  };
}

/**
 * Packages the pinned Pixel Agents sprite data for the browser-only live office.
 *
 * The upstream webview normally receives decoded sprites from the extension or
 * standalone server. Pixel Index is a static SPA, so this plugin performs that
 * decoding at build time instead. The pinned commit is part of every URL: nginx
 * and CDNs can cache these fairly large JSON sidecars forever without a vendor
 * update ever reusing a stale filename.
 */
export function liveOfficeAssets(projectRoot: string): Plugin {
  const repositoryRoot = path.resolve(projectRoot, '../..');
  const upstreamRoot = path.join(repositoryRoot, 'vendor/pixel-agents');
  const assetsDir = path.join(upstreamRoot, 'webview-ui/public/assets');
  const pinPath = path.join(repositoryRoot, 'vendor/pixel-agents.commit');
  const previewTransport = path.join(projectRoot, 'src/live-office/transport.ts');

  let config: ResolvedConfig;
  let generated: GeneratedAssets | null = null;

  function pin(): string {
    const value = fs.readFileSync(pinPath, 'utf8').trim();
    if (!/^[0-9a-f]{40}$/.test(value)) {
      throw new Error('vendor/pixel-agents.commit is missing or invalid.');
    }
    return value;
  }

  function outputPrefix(): string {
    return `assets/pixel-agents/${pin()}`;
  }

  function data(): GeneratedAssets {
    generated ??= generateAssets(assetsDir, upstreamRoot);
    return generated;
  }

  return {
    name: 'live-office-assets',
    enforce: 'pre',
    configResolved(resolved) {
      config = resolved;
    },
    resolveId(source, importer) {
      // OfficeCanvas only uses the transport to persist an interactive seat
      // reassignment. The public demo has no Pixel Agents server, so replace
      // upstream's reconnecting WebSocket singleton with a connected no-op.
      if (
        importer?.startsWith(path.join(upstreamRoot, 'webview-ui/src/')) &&
        source.endsWith('/transport/index.js')
      ) {
        return previewTransport;
      }
      return null;
    },
    configureServer(server) {
      const base = server.config.base.replace(/\/$/, '');
      const routePrefix = `${base}/${outputPrefix()}/`;
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split('?', 1)[0] ?? '';
        if (!pathname.startsWith(routePrefix)) {
          next();
          return;
        }
        const filename = pathname.slice(routePrefix.length) as AssetFilename;
        if (!ASSET_FILENAMES.includes(filename)) {
          next();
          return;
        }

        response.statusCode = 200;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.setHeader('cache-control', 'no-store');
        response.end(data()[filename]);
      });
    },
    closeBundle() {
      const directory = path.resolve(config.root, config.build.outDir, outputPrefix());
      fs.mkdirSync(directory, { recursive: true });
      for (const [filename, contents] of Object.entries(data())) {
        fs.writeFileSync(path.join(directory, filename), contents);
      }
    },
  };
}
