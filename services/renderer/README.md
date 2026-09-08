# @pixel-index/renderer

`POST /render` with a layout, get a PNG back.

Previews are the most valuable thing this index shows, and their credibility comes
entirely from how they are made: **Pixel Agents' own renderer draws them**. Wall
autotiling, carpet marching-squares, per-tile colorize and z-sorting therefore match
what a user will actually see, and a preview can never drift from its layout or from the
pinned upstream.

`render.integration.test.ts` proves determinism, concurrency limits, timeouts, cache
behaviour, and the HTTP surface, all against a real render.

## How it works

The upstream webview has a dev-mode "browser mock" that decodes the bundled assets
in-page and feeds them to the app over the same message path the real server uses. The
service runs upstream's Vite dev server once at boot, then for each render opens a page
and **intercepts the fetch for the bundled default layout**, answering with the layout
being rendered. Everything on screen is then drawn by upstream's code.

### What comes out

A PNG cropped to the layout's **occupied tiles**, on a **transparent** background.

A layout's declared `cols` × `rows` is padding-inclusive: `6e3bc6dd2e` declares 53×46 and
occupies 25×27, and the three bundled seeds that share a 21×22 canvas occupy 20×11, 20×21
and 20×12. The floor of the crop comes from layout-core's `occupiedBounds()` — the same
function behind the `visibleCols`/`visibleRows` stat, rather than a private answer to the
same question — so a preview is never smaller than `visibleCols × visibleRows` tiles and
always agrees with the numbers printed beside it in the gallery.

It can be *larger*, by design: upstream draws things attached to a tile that reach outside
it. `wallTiles.ts` anchors a wall sprite at the bottom of its tile and lets tall ones
"extend upward", so the top face of a back wall lands a whole tile above the topmost
non-VOID row — cropping to the tiles alone decapitates it. The final crop is therefore the
occupied tiles **unioned with** the canvas's painted bounding box. The union direction is
the safety property: the scan can only add, so a frame caught mid-paint costs a little
extra margin rather than a silently truncated office.

The viewport is still sized from the *declared* canvas, because upstream centres the map
using those numbers (`renderOffice()`): shrinking the viewport would move that centre and
slide the office out of frame. The crop happens after the centring, not instead of it.

Transparency needs both halves of `page.screenshot({ omitBackground: true })` and an
explicitly transparent `html`/`body`. `omitBackground` only clears Chromium's *default*
backdrop, not a background the page itself declares, and the office's own VOID tiles are
already transparent (upstream skips them). Get either half wrong and the padding is
composited to solid white on the way to the encoder.

Layouts that fill their bounding box come back as RGB rather than RGBA: after the crop
there is no transparent pixel left, and Chromium drops an all-opaque alpha channel. That is
the encoder being sensible, not the background coming back.

## Why it is a separate service

It needs Chromium *and* the pinned upstream checkout, which rules out the API container
(small, stateless, horizontally scalable) and every static or serverless host. It is also
the only component that takes attacker-controlled JSON and runs a browser on it, so it
gets its own blast radius, concurrency limit and resource ceiling.

## API

### `POST /render`

```jsonc
{
  "layout": { "version": 1, "cols": 21, /* … */ },
  "scale": 1,
  // #101, optional: custom (uploaded) furniture the layout places. This
  // service has no database of its own, so services/api embeds everything
  // it needs directly here — the decoded catalog entry plus the sprite PNG
  // itself, base64-encoded.
  "customAssets": [
    { "catalogEntry": { "id": "MY_CHAIR", "furniturePath": "custom-assets/MY_CHAIR.png", /* … */ }, "pngBase64": "..." }
  ]
}
```

`scale` is `1` (default), `0.5` or `0.25`. `customAssets` extends validation's furniture
catalog for this request only (`mergeFurnitureCatalog`, `@pixel-index/layout-core`) and
is served to the browser mock via `page.route()` interception of both
`furniture-catalog.json` and `assets/decoded/furniture.json` (this vendored checkout's
own dev-server middleware fast path — see `render.ts`'s comment on why both, not just
one, need intercepting) — the same technique already used to substitute the layout
itself. Responds `image/png`, with:

| Header | Meaning |
|---|---|
| `etag` | the cache key — content-addressed, so it is stable forever |
| `cache-control` | `immutable`; the same bytes can never mean something else |
| `x-render-cache` | `hit` or `miss` |
| `x-content-sha256` | hash of the returned PNG |

| Status | When |
|---|---|
| `400` | unsupported `scale` |
| `413` | body over `RENDERER_MAX_LAYOUT_BYTES` |
| `422` | layout fails `@pixel-index/layout-core`, with structured `issues` |
| `500` | render failed |
| `504` | render exceeded `RENDERER_TIMEOUT_MS` |

Validation happens **before** a browser is involved, so a layout the index would reject
can never occupy a render slot.

### `GET /health` and `GET /ready`

`/health` is liveness. `/ready` asserts the browser is actually connected and reports the
upstream pin, in-flight count and concurrency — because a health check that always
returns 200 is how a container stays in a load balancer while broken.

## Configuration

Environment only. No hostname or path is compiled in.

| Variable | Default | Purpose |
|---|---|---|
| `RENDERER_HOST` | `::` | Dual-stack by default; see the note below |
| `RENDERER_PORT` | `3000` | |
| `RENDERER_CONCURRENCY` | `2` | Pages rendering at once. Never less than 1 |
| `RENDERER_TIMEOUT_MS` | `60000` | Per render |
| `RENDERER_MAX_LAYOUT_BYTES` | `4000000` | Refused at the socket — the whole request body, including any embedded custom-asset PNGs (#101), not just the layout JSON |
| `RENDERER_CACHE_DIR` | tmpdir | Content-addressed PNGs |
| `RENDERER_CACHE_MAX_ENTRIES` | `2000` | `0` disables the cache |
| `PIXEL_AGENTS_DIR` | auto-discovered | The pinned upstream |

A bad value fails at boot with a message naming the variable, rather than silently
falling back to a default.

## Caching

Keyed on the layout bytes **and** the upstream pin, because bumping
`vendor/pixel-agents` can change what a layout looks like — a key that ignored the pin
would serve the previous renderer's preview forever. On disk, so a redeploy is not a
render stampede, and a submission that duplicates an existing layout (dedup on the same
hash) costs nothing.

Also keyed on `RENDER_FORMAT`, because *this service* can change what a layout looks like
while the pin sits still — the crop and transparency above did exactly that. Bump it in
`cache.ts` whenever a render of the same layout at the same pin would come out different,
or every already-rendered layout keeps serving its stale image. A golden-hash test makes
the bump deliberate rather than accidental, in both directions.

At the ceiling it stops writing rather than evicting: previews are small and
deterministic, so a cold entry costs one render, while an eviction policy costs
correctness bugs. Writes go through a temp file and a rename, so a crash mid-write cannot
leave a truncated PNG to be served forever as a cache hit.

## `scale` exists, but the API never asks for less than `1`

`POST /render` still accepts `scale: 0.5 | 0.25` — downscaling happens on the canvas
already open, with `imageSmoothingEnabled = false`, sampling every Nth source pixel
exactly (verified against a manual pixel-stride decimation: zero-byte difference). As
a resize algorithm in isolation it is genuinely lossless nearest-neighbour, not the
blur `imageSmoothingEnabled` might suggest, and byte size scales as measured:

| layout | full | `scale: 0.5` | `scale: 0.25` |
|---|---|---|---|
| blue-office | 800×416, 15.0 kB | 400×208, 15.3 kB | 200×104, 6.3 kB |
| default | 640×384, 11.6 kB | 320×192, 12.7 kB | 160×96, 5.1 kB |
| four-rooms | 640×704, 24.6 kB | 320×352, 24.9 kB | 160×176, 10.2 kB |
| severance-office | 640×416, 4.6 kB | 320×208, 4.9 kB | 160×104, 2.1 kB |

(`scale: 0.5` is larger on disk than the full image, every time — halving pixel art
destroys the long runs of identical pixels PNG's filters exploit.)

`services/api` always requests `scale: 1` for both `preview.png` and `thumbnail.png`,
even though `apps/web`'s gallery card displays thumbnails much smaller: the card
stretches the PNG to a responsive, non-integer container width with CSS
`image-rendering: pixelated`, so a pre-shrunk `scale: 0.25` render would be downscaled
*twice* — once here, server-side, to a fixed 200×104-ish grid, and again by the browser
to whatever the card actually measures. Each step is individually lossless, but the
second step can only choose from the ~1-in-16 pixels the first step kept, not the
source image's full detail — a genuinely different (and, compared side-by-side, visibly
softer) result than scaling the full render straight to the card's width in one step.
Measured on `blue-office` at a representative card width: 12% of pixels differ between
the double-hop and a direct single-hop scale, mean channel error ~6/255. Same bytes, one
resize, done by the browser at the one size that actually matters. The `scale` parameter
stays in this service because it is a correct, generic capability; it's just not the
right tool for the gallery's thumbnail problem.

## Six fixes not to lose

Each of these is invisible until it bites:

- **The layout must be injected by intercepting the default-layout fetch** (`page.route`).
  Dispatching `layoutLoaded` after page load races the browser mock's own late dispatch,
  and the loser silently renders the *default* office — every preview looks entirely
  plausible and every preview is wrong. There is a test that renders two different
  layouts and asserts they differ.
- **`npx vite` orphans the real Vite process** (reparented to PID 1), so `SIGTERM`
  reaches only the wrapper and the process never exits. The binary is spawned directly
  with `detached: true` and killed as a process group.
- **Vite's `--port 0` hangs.** A free port is allocated first and passed with
  `--strictPort`.
- **`ZOOM = 2`** matches upstream's `Math.round(2 * devicePixelRatio)`. The screenshot is
  clipped, after hiding DOM chrome — an element screenshot captures the page region, so
  toolbars and toasts drawn over the canvas would otherwise land in the preview.
- **Furniture count is not a paint signal.** A layout with no furniture satisfies
  `getFurnitureCount() === 0` the instant the app mounts, before a sprite has decoded or
  the game loop has drawn a frame. The renderer used to read the canvas at that moment,
  find it blank, and fall back to an untrimmed full-canvas screenshot that landed one CDP
  round-trip later — by which time the office *had* painted, so the output looked
  plausible and was silently wrong. There is now a second wait, for the canvas to actually
  hold a painted pixel, and a test that renders a furniture-less layout.
- **`NODE_ENV=production` silently disables everything.** Vite derives
  `import.meta.env.DEV` from `NODE_ENV` *even when running the dev server*, and upstream
  gates its entire browser mock on `DEV` (`webview-ui/src/main.tsx`). In production mode
  the mock is skipped, the app falls back to a WebSocket transport pointed at a server
  that does not exist, and the office is never built — so every render times out waiting
  for furniture that will never arrive, with **no error logged anywhere**. Setting
  `NODE_ENV=production` is otherwise exactly the right thing to do for a Node service,
  which is what makes this a trap. `devServer.ts` forces `development` for the Vite child
  so the service cannot be misconfigured into it, and a unit test pins that.

## Shutdown

`SIGTERM`/`SIGINT` close the HTTP server, then the browser, then the Vite process
group — Chromium and Vite process counts return to baseline, and the container stops in
under half a second with exit `0`.

## Local development

```bash
npm ci
(cd vendor/pixel-agents && npm ci)     # the renderer runs upstream's webview
npx playwright install chromium

npm run dev --workspace @pixel-index/renderer
npm test --workspace @pixel-index/renderer              # fast; no browser
npm run test:integration --workspace @pixel-index/renderer   # real browser + Vite
```

The integration suite is opt-in because it boots Vite and Chromium, and CI runs it on
every pull request since it is the only place that exercises a real render rather than a
stub.

## Container

```bash
# Context is the repo root.
docker build -f services/renderer/Dockerfile -t pixel-index-renderer .
```

The build context is the repository root, because the image needs the workspace root, the
`layout-core` package and `vendor/pixel-agents`. Upstream's webview dev dependencies are
installed in the **runtime** stage with `--include=dev`, not just the builder: Vite is one
of them, and the service boots its dev server at run time. That is what makes previews
upstream's own work rather than a reimplementation.

Three container-specific things, each of which broke the image once:

- **The pin ships as a file, because git cannot answer here.** A copied `vendor/` tree's
  `.git` is a pointer to a gitdir outside the build context, so the commit is unreadable
  at runtime however much of the tree is copied — and without it the cache key falls back
  to the upstream *version*, which the pin routinely outruns by several commits
  (`v1.4.0-14-g9794e07`), so two different builds would share cached previews. The
  Dockerfile copies `vendor/pixel-agents.commit`, kept equal to the gitlink by
  `npm run vendor:commit` and enforced in CI. The service still logs a warning at boot
  if the file is somehow missing.
- **Ownership is set with `COPY --chown` and the vendor install runs as `pwuser`.** Vite
  bundles `vite.config.ts` to a `.timestamp-*.mjs` file *beside itself* at startup, and
  caches optimised deps under `node_modules/.vite`. A root-owned tree gives `EACCES` and
  the dev server never starts. Doing it at copy time rather than with a later `chown -R`
  avoids duplicating the whole tree into another layer.
- **`NODE_ENV` is deliberately unset.** See the fifth trap above.
