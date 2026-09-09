/**
 * Drive Pixel Agents' own renderer and screenshot what it drew.
 *
 * Ported from v1's `tools/render-previews.mjs`. The comments below are load
 * bearing: each one records a failure that was diagnosed once and is invisible
 * until it bites again.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  type Layout,
  occupiedBounds,
  readJsonOrNull,
  upstreamAssetsDir,
} from '@pixel-index/layout-core';
import { type Browser, chromium } from 'playwright';

import type { DevServer } from './devServer.js';
import { decodeSpritePng } from './spritePng.js';

const TILE_SIZE = 16;
/**
 * Upstream picks its zoom as Math.round(2 * devicePixelRatio), so at
 * deviceScaleFactor 1 the office is drawn at 2 device-pixels per sprite pixel.
 * Sizing the viewport with the same number keeps the office filling the frame.
 */
const ZOOM = 2;
const MARGIN_TILES = 1;

/**
 * An element screenshot captures the page region, not the element in isolation,
 * so the toolbars, connection badge and changelog toast drawn over the canvas
 * would end up in the preview. Hide everything, then bring the canvas back.
 *
 * html/body are NOT matched by `body *`, so their own background keeps painting
 * — and an opaque one under the canvas defeats `omitBackground` (below), which
 * only clears Chromium's default backdrop, not a background the page itself
 * declares. Forcing both transparent is what actually lets alpha through.
 */
const HIDE_CHROME_CSS = `
  html, body { background: transparent !important; }
  body * { visibility: hidden !important; }
  canvas { visibility: visible !important; }
`;

const HOOKS_TIMEOUT_MS = 60_000;
const FURNITURE_TIMEOUT_MS = 30_000;
const PAINT_TIMEOUT_MS = 30_000;

/**
 * One custom (uploaded) asset a render needs, exactly as `services/api`'s
 * `customAssetsForLayout` packaged it (#101 furniture, #105 characters +
 * pets). This service has no database of its own — it can only render what
 * the caller embeds directly in the request, and each kind needs a different
 * shape at the browser boundary (see the interception block in `renderOnce`).
 */
export type RenderCustomAsset =
  | {
      kind: 'furniture';
      /** `CatalogEntry`-shaped, plus a synthetic `furniturePath` this service serves the PNG at. */
      catalogEntry: Record<string, unknown> & {
        id: string;
        furniturePath: string;
        width: number;
        height: number;
      };
      pngBase64: string;
    }
  | {
      kind: 'character';
      /** Exactly `assets/decoded/characters.json`'s own per-entry shape — appended, not re-encoded. */
      sprites: { down: string[][][]; up: string[][][]; right: string[][][] };
    }
  | {
      kind: 'pet';
      name: string;
      /** Exactly `petSpritesLoaded`'s own per-pet shape (`core/messages.ts`'s `PetSpriteFrameSet`) — appended, not re-encoded. */
      frames: {
        walkDown: string[][][];
        idleDown: string[][][];
        walkUp: string[][][];
        idleUp: string[][][];
        walkRight: string[][][];
      };
    };

export interface RenderOptions {
  /**
   * 1 renders the canonical preview. A fraction produces a thumbnail by
   * nearest-neighbour downscaling in the page — pixel art must never be
   * resampled, and doing it on the canvas we already have avoids both an image
   * library and a second encoder.
   */
  scale?: number;
  timeoutMs?: number;
  /** Custom furniture this layout places. Omit or empty for a layout with none. */
  customAssets?: RenderCustomAsset[];
}

/** The filename the browser mock fetches as "the" layout. */
export function defaultLayoutFilename(upstreamDir?: string): string {
  const assets = upstreamAssetsDir(upstreamDir);
  const index = readJsonOrNull<{ defaultLayout?: string }>(
    path.join(assets, 'asset-index.json'),
  );
  if (index?.defaultLayout) return index.defaultLayout;

  const candidates = fs
    .readdirSync(assets)
    .filter((file) => /^default-layout(-\d+)?\.json$/.test(file))
    .sort();
  const newest = candidates[candidates.length - 1];
  if (!newest) throw new Error('No default-layout JSON found in the pinned upstream assets.');
  return newest;
}

/** A canvas-space, inclusive pixel box. */
export interface CanvasBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RenderGeometry {
  /** Viewport, sized to hold the whole declared canvas so nothing is cut off. */
  width: number;
  height: number;
  /** The part of that canvas the office's tiles occupy. */
  box: CanvasBox;
}

/**
 * The smallest box containing both.
 *
 * The crop is the occupied tiles *unioned with* what was actually painted,
 * because upstream draws things attached to a tile that reach outside it:
 * `wallTiles.ts` anchors a wall sprite at the bottom of its tile and lets tall
 * ones "extend upward", so the top face of a back wall lands a whole tile above
 * the topmost non-VOID row. Cropping to the tiles alone decapitates it.
 *
 * Union rather than the painted box alone: the tiles are the guarantee. The
 * scan can only ever *add* to the box, so a preview always contains the whole
 * layout even if a frame is caught mid-paint, and the failure mode is a little
 * extra margin rather than a silently truncated office.
 */
export function unionBox(a: CanvasBox, b: CanvasBox | null): CanvasBox {
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/**
 * Where upstream will draw this layout's occupied tiles, computed rather than
 * measured.
 *
 * The viewport still spans the *declared* `cols`×`rows`, because upstream
 * centres the map using those numbers (`renderOffice()` in
 * webview-ui/src/office/engine/renderer.ts: `offsetX = floor((canvasWidth -
 * cols * TILE_SIZE * zoom) / 2)`). Shrinking the viewport to the occupied
 * region would move that centre and slide the office out of frame — the crop
 * has to come after the centring, not instead of it.
 *
 * `occupiedBounds()` is layout-core's, the same function behind the
 * `visibleCols`/`visibleRows` stat (#55), rather than a third private answer to
 * "which part of a layout is visible" alongside it and PreviewApp.tsx's
 * `visibleTileBounds()`. The preview is then at least `visibleCols ×
 * visibleRows` tiles by construction, and says the same thing as the numbers
 * printed beside it.
 *
 * This is the floor, not the final crop: `unionBox` widens it to whatever
 * upstream actually painted. See there for why.
 */
export function renderGeometry(layout: Pick<Layout, 'cols' | 'rows' | 'tiles'>): RenderGeometry {
  const width = (layout.cols + MARGIN_TILES * 2) * TILE_SIZE * ZOOM;
  const height = (layout.rows + MARGIN_TILES * 2) * TILE_SIZE * ZOOM;

  const scale = TILE_SIZE * ZOOM;
  // Math.floor, not a plain divide: upstream floors this to land the map on
  // whole device pixels, and an off-by-half here would shear every crop by a
  // pixel on odd-sized canvases.
  const offsetX = Math.floor((width - layout.cols * scale) / 2);
  const offsetY = Math.floor((height - layout.rows * scale) / 2);

  const bounds = occupiedBounds(layout);
  return {
    width,
    height,
    box: {
      minX: offsetX + bounds.minCol * scale,
      minY: offsetY + bounds.minRow * scale,
      maxX: offsetX + (bounds.maxCol + 1) * scale - 1,
      maxY: offsetY + (bounds.maxRow + 1) * scale - 1,
    },
  };
}

/** A bounded gate. This is a browser, not a lambda — unbounded means OOM. */
class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiting.shift()?.();
    };
  }

  get inFlight(): number {
    return this.active;
  }
}

export interface RendererDeps {
  devServer: DevServer;
  concurrency: number;
  defaultTimeoutMs: number;
  upstreamDir?: string;
}

export class Renderer {
  private browser: Browser | undefined;
  private readonly gate: Semaphore;
  private readonly defaultLayoutFile: string;

  constructor(private readonly deps: RendererDeps) {
    this.gate = new Semaphore(deps.concurrency);
    this.defaultLayoutFile = defaultLayoutFilename(deps.upstreamDir);
  }

  async start(): Promise<void> {
    this.browser ??= await chromium.launch();
  }

  get inFlight(): number {
    return this.gate.inFlight;
  }

  get isRunning(): boolean {
    return this.browser?.isConnected() ?? false;
  }

  async render(layout: Layout, options: RenderOptions = {}): Promise<Buffer> {
    if (!this.browser) throw new Error('Renderer has not been started.');
    const scale = options.scale ?? 1;
    const timeoutMs = options.timeoutMs ?? this.deps.defaultTimeoutMs;
    const customAssets = options.customAssets ?? [];

    const release = await this.gate.acquire();
    try {
      return await withTimeout(this.renderOnce(this.browser, layout, scale, customAssets), timeoutMs);
    } finally {
      release();
    }
  }

  /**
   * Takes the browser rather than reading `this.browser` again. `render()`
   * checks it on the line above, but narrowing does not cross a method
   * boundary — correctly, because `close()` could null the field in between.
   * Passing it pins the instance for the whole render.
   */
  private async renderOnce(
    browser: Browser,
    layout: Layout,
    scale: number,
    customAssets: RenderCustomAsset[],
  ): Promise<Buffer> {
    const { width, height, box: tileBox } = renderGeometry(layout);

    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });

    try {
      // Turn on upstream's test hooks so we can wait on real render state
      // instead of sleeping and hoping.
      await context.addInitScript(() => {
        window.__PIXEL_AGENTS_E2E = true;
      });
      const page = await context.newPage();

      // Serve OUR layout where the mock asks for the bundled default.
      //
      // Dispatching a layoutLoaded after page load instead would race the mock's
      // own dispatch, which lands late and would silently win — every preview
      // would then show the DEFAULT office while looking entirely plausible.
      // Substituting the fetch removes the race: the mock only ever sees one
      // layout, and it is this one.
      await page.route(`**/assets/${this.defaultLayoutFile}`, (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(layout) }),
      );

      const furnitureAssets = customAssets.filter((asset) => asset.kind === 'furniture');
      const characterAssets = customAssets.filter((asset) => asset.kind === 'character');
      const petAssets = customAssets.filter((asset) => asset.kind === 'pet');

      // #101: custom (uploaded) furniture. The browser mock always fetches
      // `furniture-catalog.json`, so that always needs appending to. Its
      // sprite *pixels* come from one of two places, and — found by actually
      // running this against the real dev server, not assumed from reading
      // `browserMock.ts` alone — upstream's own `vite.config.ts` serves
      // `assets/decoded/*.json` from a dev-only middleware that decodes
      // whatever is really on disk, not a static file; it exists in every
      // deployment this service can reach (the dev server needs `npm ci` in
      // the vendor checkout to run at all, and that's what generates it), so
      // the mock takes that fast path here, never the per-PNG-fetch fallback
      // `decodeFurnitureFromPng` is for. Both are intercepted so this works
      // whichever path a given upstream checkout actually takes.
      if (furnitureAssets.length > 0) {
        await page.route('**/assets/furniture-catalog.json', async (route) => {
          const response = await route.fetch();
          const catalog = (await response.json()) as unknown[];
          catalog.push(...furnitureAssets.map((asset) => asset.catalogEntry));
          await route.fulfill({ response, json: catalog });
        });
        await page.route('**/assets/decoded/furniture.json', async (route) => {
          const response = await route.fetch();
          // A checkout without the decoded-JSON middleware 404s here — leave
          // it exactly as it was and let the mock's own PNG-fetch fallback
          // (below) supply these sprites instead.
          if (!response.ok()) return route.fulfill({ response });
          const sprites = (await response.json()) as Record<string, string[][]>;
          for (const asset of furnitureAssets) {
            const { id, width, height } = asset.catalogEntry;
            sprites[id] = decodeSpritePng(Buffer.from(asset.pngBase64, 'base64'), width, height);
          }
          await route.fulfill({ response, json: sprites });
        });
        for (const asset of furnitureAssets) {
          await page.route(`**/assets/${asset.catalogEntry.furniturePath}`, (route) =>
            route.fulfill({ contentType: 'image/png', body: Buffer.from(asset.pngBase64, 'base64') }),
          );
        }
      }

      // #105: custom (uploaded) characters. `browserMock.ts` fetches
      // `assets/decoded/characters.json` exactly like furniture's decoded
      // JSON — verified against the real dev server, same as furniture above
      // — so the same append-to-the-fetched-array technique generalizes
      // directly. No per-PNG fallback route: this vendored checkout always
      // serves the decoded endpoint (same bet furniture's own comment makes).
      if (characterAssets.length > 0) {
        await page.route('**/assets/decoded/characters.json', async (route) => {
          const response = await route.fetch();
          const characters = (await response.json()) as unknown[];
          characters.push(...characterAssets.map((asset) => asset.sprites));
          await route.fulfill({ response, json: characters });
        });
      }

      // #105: custom (uploaded) pets. Unlike furniture and characters, there
      // is no fetch to intercept here — traced all the way through
      // `browserMock.ts` and it never requests or dispatches anything
      // pet-related at all (confirmed against a real checkout, not assumed):
      // pet templates only ever reach the app via a `petSpritesLoaded`
      // `postMessage`, which the real VS Code extension host/standalone
      // server sends and this dev-server mock never does. There is also no
      // bundled pet in this checkout to preserve — pets are wholly an
      // external-loading feature, so this is the only way *any* pet, custom
      // or otherwise, ever renders through this service.
      //
      // Synthesized by wrapping `window.dispatchEvent`, before the page's own
      // scripts run, so it can inject our message immediately ahead of every
      // `layoutLoaded` dispatch — pet templates must be known before the
      // layout's pet roster is reconciled against them, and patching the
      // dispatch call is the only hook available since this isn't a network
      // request `page.route()` can intercept.
      //
      // NOT one-shot: found by actually running this against the real dev
      // server, not assumed from reading the mock's source alone — Vite's dev
      // mode double-invokes effects (React StrictMode), so `dispatchMockMessages()`
      // itself runs twice, and only the OfficeState the SECOND `layoutLoaded`
      // constructs survives. Gating this to fire once (before only the first)
      // left a live app whose pets were never actually placed — `getPets()`
      // reported none — while every log line upstream of pet placement still
      // looked correct, which is exactly the kind of silent gap the CI guard
      // (#105 decision #6) exists to keep catching. `setPetTemplates` is a
      // plain replace of a module-level array, so re-sending ahead of every
      // `layoutLoaded` is idempotent, not merely tolerated.
      if (petAssets.length > 0) {
        await context.addInitScript((pets: { name: string; frames: unknown }[]) => {
          const realDispatch = window.dispatchEvent.bind(window);
          window.dispatchEvent = (event: Event) => {
            if (
              event instanceof MessageEvent &&
              event.data &&
              typeof event.data === 'object' &&
              (event.data as { type?: unknown }).type === 'layoutLoaded'
            ) {
              realDispatch(
                new MessageEvent('message', {
                  data: {
                    type: 'petSpritesLoaded',
                    pets: pets.map((pet) => pet.frames),
                    petNames: pets.map((pet) => pet.name),
                  },
                }),
              );
            }
            return realDispatch(event);
          };
        }, petAssets.map((asset) => ({ name: asset.name, frames: asset.frames })));
      }

      await page.goto(this.deps.devServer.url, { waitUntil: 'load' });

      // The browser mock decodes every PNG in-page; the hooks appear once the
      // app has mounted.
      await page.waitForFunction(
        () => typeof window.__pixelAgentsTestHooks?.getFurnitureCount === 'function',
        null,
        { timeout: HOOKS_TIMEOUT_MS },
      );

      // Wait for the office to actually hold this layout's furniture, so the
      // screenshot can never catch an empty or half-built office.
      // `layout` is a validated Layout by the time it reaches here (server.ts
      // and the harness both validate before casting), so `furniture` is
      // present — no defensive `?.` pretending otherwise.
      const expected = layout.furniture.length;
      await page.waitForFunction(
        (count) => window.__pixelAgentsTestHooks?.getFurnitureCount?.() === count,
        expected,
        { timeout: FURNITURE_TIMEOUT_MS },
      );

      // A layout with no furniture satisfies the count above the instant the
      // app mounts — before a single sprite has decoded and before the game
      // loop's first paint. The screenshot then caught a blank canvas (#71).
      // Furniture count says "the office holds the right things"; it does not
      // say "the office has been drawn", so ask the canvas directly.
      await page.waitForFunction(
        () => {
          const canvas = document.querySelector('canvas');
          if (!canvas || canvas.width === 0) return false;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) return false;
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] !== 0) return true;
          }
          return false;
        },
        null,
        { timeout: PAINT_TIMEOUT_MS },
      );

      await page.addStyleTag({ content: HIDE_CHROME_CSS });
      // One more frame so the freshly built instances are painted.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );

      // What upstream drew, which is the tiles plus whatever hangs off them.
      const painted = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return null;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        const { data, width: w, height: h } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let minX = w;
        let minY = h;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] === 0) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
        return maxX < 0 ? null : { minX, minY, maxX, maxY };
      });
      const box = unionBox(tileBox, painted);

      if (scale !== 1) return await this.thumbnail(page, box, scale);

      // `box` is canvas space; `clip` is page space. Deriving one from the
      // other in the page — rather than assuming the canvas sits at the origin
      // at 1:1 — keeps the crop right if upstream ever puts chrome above it.
      const clip = await page.evaluate((canvasBox) => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const ratio = rect.width / canvas.width;
        return {
          x: rect.x + canvasBox.minX * ratio,
          y: rect.y + canvasBox.minY * ratio,
          width: (canvasBox.maxX - canvasBox.minX + 1) * ratio,
          height: (canvasBox.maxY - canvasBox.minY + 1) * ratio,
        };
      }, box);

      // `omitBackground` is what makes the PNG carry an alpha channel at all.
      // Without it Chromium composites onto its default opaque white page
      // backdrop, and the padding around the office — genuinely transparent on
      // the canvas, since upstream skips VOID tiles — was baked out to solid
      // white before it ever reached the encoder (#71).
      if (clip) return await page.screenshot({ clip, animations: 'disabled', omitBackground: true });
      // No canvas at all — screenshot whatever is there so the failure is
      // visible in the gallery rather than silently missing.
      return await page
        .locator('canvas')
        .first()
        .screenshot({ animations: 'disabled', omitBackground: true });
    } finally {
      await context.close();
    }
  }

  /**
   * Downscale in the page with smoothing off.
   *
   * Pixel art resampled with a smoothing filter turns to mush, and doing this on
   * the canvas that is already open avoids adding a native image library to an
   * image that is already 400 MB of browser.
   */
  private async thumbnail(
    page: import('playwright').Page,
    box: CanvasBox,
    scale: number,
  ): Promise<Buffer> {
    const dataUrl = await page.evaluate(
      ({ box, factor }) => {
        const source = document.querySelector('canvas');
        if (!source) return null;
        const sx = box.minX;
        const sy = box.minY;
        const sw = box.maxX - box.minX + 1;
        const sh = box.maxY - box.minY + 1;

        // Left transparent, never filled: drawImage copies the source's alpha,
        // so the padding around the office stays see-through here too.
        const target = document.createElement('canvas');
        target.width = Math.max(1, Math.round(sw * factor));
        target.height = Math.max(1, Math.round(sh * factor));
        const ctx = target.getContext('2d');
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(source, sx, sy, sw, sh, 0, 0, target.width, target.height);
        return target.toDataURL('image/png');
      },
      { box, factor: scale },
    );

    if (!dataUrl) throw new Error('Nothing was painted, so no thumbnail could be produced.');
    return Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RenderTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class RenderTimeoutError extends Error {
  constructor(ms: number) {
    super(`Render exceeded ${ms}ms`);
    this.name = 'RenderTimeoutError';
  }
}
