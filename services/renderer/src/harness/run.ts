/**
 * Render a set of layouts against one pinned upstream.
 *
 * This is a driver, not a renderer: `startDevServer`, `Renderer` and
 * `createValidator` are the same ones the service itself uses, unmodified.
 * The gate has to measure what production does, and the only way to be sure of
 * that is to run production's code.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  createValidator,
  type Layout,
  mergeFurnitureCatalog,
  sha256,
  upstreamPin,
  validateLayout,
} from '@pixel-index/layout-core';

import { type DevServer, startDevServer } from '../devServer.js';
import { type RenderCustomAsset, Renderer, RenderTimeoutError } from '../render.js';
import { HarnessInfraError, type HarnessLayout, type LayoutOutcome, type PinRun } from './types.js';

export interface RunPinOptions {
  /** The pinned checkout to measure. Defaults to whatever `resolveUpstreamDir` finds. */
  upstreamDir?: string;
  /** Where the layouts came from, recorded for the report. */
  source: string;
  /** When set, every successful render is written here as `<slug>.png`. */
  pngDir?: string;
  concurrency?: number;
  timeoutMs?: number;
  /** Injectable so the tests do not need a browser. */
  deps?: RunPinDeps;
  onProgress?: (done: number, total: number) => void;
}

/** The two heavy things, hoisted so a test can supply fakes. */
export interface RunPinDeps {
  startDevServer: typeof startDevServer;
  createRenderer: (devServer: DevServer, concurrency: number, timeoutMs: number) => RendererLike;
}

export interface RendererLike {
  start: () => Promise<void>;
  render: (layout: Layout, options?: { customAssets?: RenderCustomAsset[] }) => Promise<Buffer>;
  close: () => Promise<void>;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 120_000;

const realDeps: RunPinDeps = {
  startDevServer,
  createRenderer: (devServer, concurrency, defaultTimeoutMs) =>
    new Renderer({ devServer, concurrency, defaultTimeoutMs }),
};

export async function runPin(
  layouts: HarnessLayout[],
  options: RunPinOptions,
): Promise<PinRun> {
  const {
    upstreamDir,
    source,
    pngDir,
    concurrency = DEFAULT_CONCURRENCY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    deps = realDeps,
    onProgress,
  } = options;

  const startedAt = new Date().toISOString();

  // Everything before the first render is environment, so anything that throws
  // here is infrastructure — not a verdict about the vendor. A Vite that will
  // not boot on a cold runner (see devServer.ts's own 200s note) must never be
  // reported as "this upstream breaks layouts".
  let pin;
  let validator;
  try {
    pin = upstreamPin(upstreamDir);
    validator = createValidator({
      ...(upstreamDir ? { upstreamDir } : {}),
      upstreamVersion: pin.version,
    });
  } catch (error) {
    throw new HarnessInfraError('Could not read the pinned upstream.', error);
  }

  let devServer: DevServer;
  try {
    devServer = await deps.startDevServer(upstreamDir);
  } catch (error) {
    throw new HarnessInfraError('The upstream dev server did not start.', error);
  }

  const renderer = deps.createRenderer(devServer, concurrency, timeoutMs);
  const outcomes: Record<string, LayoutOutcome> = {};

  try {
    try {
      await renderer.start();
    } catch (error) {
      throw new HarnessInfraError('The browser did not start.', error);
    }

    if (pngDir) fs.mkdirSync(pngDir, { recursive: true });

    let done = 0;
    // Sequential at this level; `Renderer` has its own semaphore, so feeding it
    // faster than `concurrency` would only queue inside it and lose the tidy
    // progress reporting.
    for (const item of layouts) {
      outcomes[item.slug] = await renderOne(renderer, validator, pin.version, item, pngDir);
      done += 1;
      onProgress?.(done, layouts.length);
    }
  } finally {
    await renderer.close().catch(() => {
      // A browser that will not shut down cleanly must not mask whatever is
      // already propagating out of the try, and must not stop devServer.stop()
      // on the next line from running.
    });
    devServer.stop();
  }

  return { pin, source, outcomes, startedAt, finishedAt: new Date().toISOString() };
}

/** The `catalogEntry`-shaped subset of a fixture's customAssets — the same filter `services/api`'s `furnitureCatalogEntries` applies. */
function furnitureCatalogEntries(assets: RenderCustomAsset[] | undefined): ({ id: string } & Record<string, unknown>)[] {
  if (!assets) return [];
  return assets
    .filter((asset): asset is Extract<RenderCustomAsset, { kind: 'furniture' }> => asset.kind === 'furniture')
    .map((asset) => asset.catalogEntry);
}

async function renderOne(
  renderer: RendererLike,
  validator: ReturnType<typeof createValidator>,
  upstreamVersion: string | null,
  item: HarnessLayout,
  pngDir: string | undefined,
): Promise<LayoutOutcome> {
  // Validate first, exactly as the service does — a layout the index would
  // reject never occupies a render slot, and "unknown furniture id" is a far
  // more useful report line than whatever the browser would have drawn.
  //
  // #105: a fixture's own custom furniture is not in the pinned catalog by
  // definition — merge it in first, the same way `services/renderer`'s own
  // `/render` route does, or every `seed-custom-assets/` furniture fixture
  // would fail validation as "unknown furniture" before ever reaching a
  // browser.
  const customFurniture = furnitureCatalogEntries(item.customAssets);
  const { valid, issues } =
    customFurniture.length > 0
      ? validateLayout(item.layout, {
          catalog: mergeFurnitureCatalog(validator.catalog, customFurniture),
          requiredRevision: validator.requiredRevision,
          upstreamVersion,
        })
      : validator.validateLayout(item.layout);
  if (!valid) return { status: 'invalid', issues };

  const attempt = async (): Promise<Buffer> =>
    renderer.render(item.layout as Layout, item.customAssets ? { customAssets: item.customAssets } : undefined);

  let png: Buffer;
  let retried = false;
  try {
    png = await attempt();
  } catch {
    // Retry once, and only the failures. A genuine incompatibility is
    // deterministic and will fail again; a timeout on a contended runner
    // usually will not. This is the cheapest available discriminator between
    // "upstream broke this" and "CI had a bad minute".
    retried = true;
    try {
      png = await attempt();
    } catch (second) {
      return {
        status: 'render_failed',
        kind: second instanceof RenderTimeoutError ? 'timeout' : 'error',
        message: second instanceof Error ? second.message : String(second),
      };
    }
  }

  if (pngDir) fs.writeFileSync(path.join(pngDir, `${item.slug}.png`), png);
  return { status: 'ok', pngSha256: sha256(png), bytes: png.length, ...(retried ? { retried } : {}) };
}
