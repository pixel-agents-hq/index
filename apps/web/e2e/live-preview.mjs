/**
 * Browser regression guard for the live layout-detail preview, and for the
 * editor that shares its frame (#65).
 *
 * This deliberately uses the default layout from the pinned Pixel Agents
 * checkout and the production Vite bundle. A vendor bump can compile while
 * still failing at runtime because decoded asset payloads, layout migration,
 * canvas setup, or upstream Tailwind classes changed. Driving the real iframe
 * in Chromium catches those integration failures before the pin is merged.
 *
 * The editor half ends by validating the layout it produced with
 * `@pixel-index/layout-core` — the same validation the API runs on publish.
 * A blank layout drawn here would otherwise sail through the browser and be
 * rejected at the last step, because upstream's `createDefaultLayout()` has no
 * `layoutRevision` at all.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { layoutStats, validateLayout } from '@pixel-index/layout-core';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const REPOSITORY_ROOT = path.resolve(WEB_ROOT, '../..');
const DIST = path.join(WEB_ROOT, 'dist');
const UPSTREAM_ASSETS = path.join(
  REPOSITORY_ROOT,
  'vendor/pixel-agents/webview-ui/public/assets',
);
const WEB_PORT = 4173;
const API_PORT = 4174;
const BASE_PATH = '/pixel-index/';
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const PAGE_URL = `${WEB_ORIGIN}${BASE_PATH}layouts/default`;
// The login code AuthProvider consumes out of the hash. The mock API below
// answers it with a member who may submit, which is what the editor gates on.
const EDITOR_URL = `${WEB_ORIGIN}${BASE_PATH}editor#pixelIndexLoginCode=e2e`;
const UPSTREAM_DIR = path.join(REPOSITORY_ROOT, 'vendor/pixel-agents');
/** Upstream's `TileType.VOID` — what the Erase tool leaves behind. */
const VOID_TILE = 255;
const SCREENSHOT = path.join(WEB_ROOT, 'test-results/live-preview-failure.png');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function pinnedDefaultLayout() {
  const candidates = fs
    .readdirSync(UPSTREAM_ASSETS)
    .map((filename) => {
      const match = /^default-layout(?:-(\d+))?\.json$/.exec(filename);
      return match ? { filename, revision: Number(match[1] ?? 0) } : null;
    })
    .filter((candidate) => candidate !== null)
    .sort((left, right) => right.revision - left.revision);
  const newest = candidates[0];
  assert(newest, `No default layout found in ${UPSTREAM_ASSETS}.`);
  const source = fs.readFileSync(
    path.join(UPSTREAM_ASSETS, newest.filename),
    'utf8',
  );
  return { layout: JSON.parse(source), source };
}

function detailResponse(layout, source) {
  return {
    slug: 'default',
    title: 'Pinned Default Office',
    author: { id: null, username: 'pixel-agents', avatarUrl: null },
    description: 'The default layout from the pinned Pixel Agents checkout.',
    tags: ['default'],
    cols: layout.cols,
    rows: layout.rows,
    furniture: layout.furniture?.length ?? 0,
    areas: layout.areas?.length ?? 0,
    pets: layout.pets?.length ?? 0,
    carpets: layout.carpetTiles?.filter(Boolean).length ?? 0,
    // The real API derives this from the furniture catalog (#48) — computed
    // here too, rather than hardcoded, so a vendor bump that changes the
    // pinned default layout's seating can't silently desync this fixture
    // from what LiveOfficePreview actually renders against.
    seats: layoutStats(layout).seats,
    layoutRevision: layout.layoutRevision ?? 0,
    pixelAgentsVersion: null,
    bytes: Buffer.byteLength(source),
    sha256: '0'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    files: {
      layout: '/api/v1/layouts/default/download',
      preview: '/api/v1/layouts/default/preview.png',
      thumbnail: '/api/v1/layouts/default/thumbnail.png',
    },
    layout,
  };
}

const E2E_USER = {
  id: 'e2e-user',
  discordId: 'e2e-discord-id',
  username: 'e2e',
  displayName: 'e2e',
  avatarUrl: null,
  role: 'user',
  capabilityCheckedAt: '2026-01-01T00:00:00.000Z',
  capabilityCacheTtlMs: 600_000,
  submission: { allowed: true, reason: null, inviteUrl: null },
};

function sendJson(response, value) {
  response.statusCode = 200;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

function mockApi(layout, source) {
  const detail = detailResponse(layout, source);
  return createServer((request, response) => {
    response.setHeader('access-control-allow-origin', WEB_ORIGIN);
    // The reads this file started with are simple requests and need no
    // preflight. Logging in does: it POSTs JSON with an Authorization header,
    // which the browser will not send unless the preflight allows both.
    response.setHeader('access-control-allow-headers', 'authorization, content-type');
    response.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE');
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }

    const pathname = new URL(request.url ?? '/', API_ORIGIN).pathname;
    if (pathname === '/api/v1/layouts/default') {
      sendJson(response, detail);
      return;
    }
    if (pathname === '/api/v1/layouts/default/download') {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(source);
      return;
    }
    if (
      pathname === '/api/v1/layouts/default/preview.png' ||
      pathname === '/api/v1/layouts/default/thumbnail.png'
    ) {
      response.statusCode = 200;
      response.setHeader('content-type', 'image/png');
      response.end(ONE_PIXEL_PNG);
      return;
    }
    // Enough of a session for the editor's gate: a Discord member who is
    // allowed to submit. Every write the editor could make is stubbed out
    // below — this run proves the browser half, not the API's.
    if (pathname === '/api/v1/auth/token' || pathname === '/api/v1/auth/refresh') {
      sendJson(response, {
        accessToken: 'e2e-access-token',
        refreshToken: 'e2e-refresh-token',
        expiresInMs: 900_000,
        user: E2E_USER,
      });
      return;
    }
    if (pathname === '/api/v1/me') {
      sendJson(response, E2E_USER);
      return;
    }
    // The API root (#32) — /submit resolves the content-policy link from it.
    if (pathname === '/') {
      sendJson(response, {
        name: 'Pixel Index API',
        description: 'Mock API for the browser regression guard.',
        version: '1',
        commit: 'a'.repeat(40),
        documentation: `${API_ORIGIN}/docs`,
        openapi: `${API_ORIGIN}/openapi.json`,
        repository: 'https://github.com/pixel-agents-hq/index',
      });
      return;
    }
    // #101: the live-office bundle merges this into the built-in furniture
    // catalog before ever calling buildDynamicCatalog(). No custom assets
    // exist in this fixture — an empty catalog is a legitimate, common
    // response, not a special case this mock needs to fake data for.
    if (pathname === '/api/v1/assets/catalog') {
      sendJson(response, { schemaVersion: 1, catalog: [], sprites: {} });
      return;
    }
    if (pathname === '/api/v1/meta') {
      sendJson(response, {
        schemaVersion: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        pixelAgents: {
          version: null,
          commit: fs
            .readFileSync(
              path.join(REPOSITORY_ROOT, 'vendor/pixel-agents.commit'),
              'utf8',
            )
            .trim(),
          layoutRevision: layout.layoutRevision ?? 0,
        },
        count: 1,
      });
      return;
    }

    response.statusCode = 404;
    response.end('Not found');
  });
}

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
};

/** Serve dist/ at the same project subpath GitHub Pages uses in production. */
function staticWeb() {
  return createServer((request, response) => {
    const pathname = decodeURIComponent(
      new URL(request.url ?? '/', WEB_ORIGIN).pathname,
    );
    if (!pathname.startsWith(BASE_PATH)) {
      response.statusCode = 404;
      response.end('Not found');
      return;
    }

    const relative = pathname.slice(BASE_PATH.length);
    const candidate = path.resolve(DIST, relative || 'index.html');
    const insideDist =
      candidate === DIST || candidate.startsWith(`${DIST}${path.sep}`);
    if (
      insideDist &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile()
    ) {
      response.statusCode = 200;
      response.setHeader(
        'content-type',
        CONTENT_TYPES[path.extname(candidate)] ?? 'application/octet-stream',
      );
      response.end(fs.readFileSync(candidate));
      return;
    }

    // BrowserRouter routes fall back to the SPA. Requests for missing assets
    // stay 404 so the test cannot mistake index.html for a successful script.
    if (!path.extname(relative)) {
      response.statusCode = 200;
      response.setHeader('content-type', CONTENT_TYPES['.html']);
      response.end(fs.readFileSync(path.join(DIST, 'index.html')));
      return;
    }
    response.statusCode = 404;
    response.end('Not found');
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(npm, ['run', 'build'], {
      cwd: WEB_ROOT,
      env: {
        ...process.env,
        VITE_API_BASE_URL: API_ORIGIN,
        VITE_BASE_PATH: BASE_PATH,
      },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `The production web build failed (${signal ?? `exit ${code}`}).`,
          ),
        );
    });
  });
}

async function getLiveFrame(page) {
  const iframe = page.locator('iframe[title*="live Pixel Agents office"]');
  await iframe.waitFor({ state: 'visible' });
  const handle = await iframe.elementHandle();
  const frame = await handle?.contentFrame();
  assert(frame, 'The live-office iframe did not attach a browsing context.');
  await frame.locator('canvas').waitFor({ state: 'visible' });
  return frame;
}

async function assertRenderedOffice(frame, expectedAgents) {
  await frame.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-testid="agent-overlay"]').length ===
      count,
    expectedAgents,
  );
  await frame.waitForFunction(() => {
    const canvas = document.querySelector('canvas');
    if (
      !(canvas instanceof HTMLCanvasElement) ||
      canvas.width === 0 ||
      canvas.height === 0
    ) {
      return false;
    }
    const pixels = canvas
      .getContext('2d')
      ?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!pixels) return false;
    let opaque = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] !== 0 && ++opaque >= 1_000) return true;
    }
    return false;
  });

  const overlays = await frame
    .locator('[data-testid="agent-overlay"]')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          activity: element.textContent ?? '',
          centerError: Math.abs(
            bounds.left +
              bounds.width / 2 -
              Number.parseFloat(element.style.left),
          ),
        };
      }),
    );
  for (const overlay of overlays) {
    assert(
      overlay.centerError <= 1.5,
      `An upstream activity panel is not centered on its agent (${overlay.centerError.toFixed(1)}px error).`,
    );
  }
  return overlays.map((overlay) => overlay.activity);
}

/**
 * Draw a layout from scratch and follow it all the way to the submit form.
 *
 * The whole point is that no fixture is involved: the layout starts as
 * upstream's blank room inside the frame, is edited by real clicks on the real
 * canvas, and comes back out as the bytes `/submit` would publish.
 */
async function assertEditorRoundTrip(page) {
  await page.goto(EDITOR_URL, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'New layout' }).waitFor();

  const iframe = page.locator('iframe[title="Pixel Agents office editor"]');
  await iframe.waitFor({ state: 'visible' });
  const frame = await (await iframe.elementHandle())?.contentFrame();
  assert(frame, 'The editor iframe did not attach a browsing context.');

  const canvas = frame.locator('canvas');
  await canvas.waitFor({ state: 'visible' });
  // Upstream's toolbar, rendered from upstream's own theme inside this frame.
  await frame.getByRole('button', { name: 'Furniture' }).waitFor();

  // Count the layouts the frame posts from here on. Edits are debounced, so
  // the page holds the pre-edit bytes for a moment after the click — waiting
  // on the protocol itself is what makes this deterministic without a sleep.
  await page.evaluate((channel) => {
    const counter = window;
    counter.__editorLayouts = 0;
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (data && data.channel === channel && data.type === 'layout') {
        counter.__editorLayouts += 1;
      }
    });
  }, 'pixel-index-live-office');

  // Erase is the one tool whose effect is unambiguous from the JSON alone: the
  // blank room contains no VOID tiles at all until something erases one.
  await frame.getByRole('button', { name: 'Erase' }).click();
  const box = await canvas.boundingBox();
  assert(box, 'The editor canvas has no layout box.');
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.waitForFunction(() => window.__editorLayouts > 0);

  await page.getByRole('button', { name: 'Continue to publish' }).click();
  const textarea = page.getByPlaceholder('{"version": 1, "layoutRevision": ...}');
  await textarea.waitFor();
  const raw = await textarea.inputValue();
  assert(raw, 'The editor handed the submit form an empty layout.');

  const drawn = JSON.parse(raw);
  assert(
    drawn.tiles.includes(VOID_TILE),
    'Erasing a tile in the editor did not reach the layout the submit form was given.',
  );

  const validation = validateLayout(drawn, { upstreamDir: UPSTREAM_DIR });
  assert(
    validation.valid,
    `The layout the editor produced would be rejected on publish:\n${validation.issues
      .map((issue) => `${issue.code} ${issue.path}: ${issue.message}`)
      .join('\n')}`,
  );
}

async function run() {
  const { layout, source } = pinnedDefaultLayout();
  await runBuild();

  const api = mockApi(layout, source);
  const web = staticWeb();
  let browser;
  let page;
  const runtimeErrors = [];

  try {
    await listen(api, API_PORT);
    await listen(web, WEB_PORT);

    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
    });
    page = await context.newPage();
    page.on('pageerror', (error) =>
      runtimeErrors.push(`page error: ${error.message}`),
    );
    page.on('console', (message) => {
      if (message.type() === 'error')
        runtimeErrors.push(`console error: ${message.text()}`);
    });
    page.on('requestfailed', (request) => {
      const reason = request.failure()?.errorText ?? 'unknown';
      if (reason !== 'net::ERR_ABORTED') {
        runtimeErrors.push(`request failed: ${request.url()} (${reason})`);
      }
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        runtimeErrors.push(`response ${response.status()}: ${response.url()}`);
      }
    });

    await page.goto(PAGE_URL, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Office preview' }).waitFor();
    let frame = await getLiveFrame(page);
    const activities = await assertRenderedOffice(frame, 3);
    for (const expected of [
      'Exploring the codebase',
      'Writing implementation',
      'Running the test suite',
    ]) {
      assert(
        activities.some((activity) => activity.includes(expected)),
        `Missing mock activity: ${expected}`,
      );
    }

    await page.getByRole('button', { name: 'Add mock agent' }).click();
    await page.getByText('4 mock agents', { exact: true }).waitFor();
    await assertRenderedOffice(frame, 4);

    await page.getByRole('button', { name: 'Remove mock agent' }).click();
    await page.getByText('3 mock agents', { exact: true }).waitFor();
    await assertRenderedOffice(frame, 3);

    await page.getByRole('button', { name: 'Thumbnail' }).click();
    await page
      .getByAltText('Pinned Default Office office layout thumbnail')
      .waitFor();
    assert.equal(
      await page
        .getByRole('button', { name: 'Thumbnail' })
        .getAttribute('aria-pressed'),
      'true',
    );

    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(
      await page
        .getByRole('button', { name: 'Thumbnail' })
        .getAttribute('aria-pressed'),
      'true',
      'The thumbnail preference did not survive a reload.',
    );

    await page.getByRole('button', { name: 'Live' }).click();
    frame = await getLiveFrame(page);
    await assertRenderedOffice(frame, 3);

    // Last, deliberately: this is the step that logs in, and the checks above
    // are all about what an anonymous visitor sees.
    await assertEditorRoundTrip(page);

    assert.deepEqual(
      runtimeErrors,
      [],
      `Browser runtime failures:\n${runtimeErrors.join('\n')}`,
    );
    console.log(
      '✓ live preview rendered the pinned layout and passed browser interactions',
    );
    console.log('✓ the editor drew a publishable layout and handed it to /submit');
  } catch (error) {
    if (page) {
      fs.mkdirSync(path.dirname(SCREENSHOT), { recursive: true });
      await page
        .screenshot({ path: SCREENSHOT, fullPage: true })
        .catch(() => {});
      console.error(`Failure screenshot: ${SCREENSHOT}`);
    }
    if (runtimeErrors.length > 0) console.error(runtimeErrors.join('\n'));
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    web.closeAllConnections();
    await closeServer(web).catch(() => {});
    api.closeAllConnections();
    await closeServer(api).catch(() => {});
  }
}

try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
