# @pixel-index/web

The gallery. Vite + React + Tailwind, matching `vendor/pixel-agents/webview-ui` exactly
so design tokens can be lifted from upstream rather than re-derived by eye.

Built as a **static SPA**: GitHub Pages serves production from `main`, Vercel builds the
same output for per-pull-request previews. Login with Discord, submit with a real
pre-publish preview, manage your own layouts, a moderation console, an admin console —
styled with tokens lifted from the office webview and the docs site, not invented.

## Source map

```text
src/main.tsx                     mounts <App>, wrapped in BrowserRouter + ThemeProvider +
                                  AuthProvider
src/App.tsx                      routes, public /authors/:id and authenticated dashboard pages
src/index.css                    design tokens — see below
src/theme/ThemeProvider.tsx      light/dark toggle, persisted to localStorage
src/theme/themeState.ts          the theme context and useTheme(), apart from the provider
                                  so the provider module hot-reloads in place
src/components/Layout.tsx        header, role-aware nav (login/logout, submit, my layouts,
                                  moderation, admin — a convenience, never the real gate)
src/components/RequireAuth.tsx   client-side route gate: "log in" / "moderators only" —
                                  UX only, the API is what actually enforces a role
src/components/LayoutCard.tsx    the gallery grid's card: preview, title, author, facts
src/components/PreviewImage.tsx  solid bg-canvas backdrop, image-rendering:pixelated,
                                  missing-preview placeholder
src/components/LiveOfficePreview.tsx
                                  persisted live/thumbnail toggle + mock-agent controls
src/components/LayoutJsonPanel.tsx
                                  auto-formatted download source, copy + download
src/components/FactsRow.tsx      renders "25×22 · 59 furniture · 4 areas · 2 pets"
src/components/facts.ts          factsFor(): builds those strings, zero-valued facts
                                  omitted, carried over from v1
src/components/AuthorLink.tsx    linked authors open their public profile and layouts
src/components/FilterBar.tsx     search, sort, size/pets/furniture filters, the tag
                                  multi-select (populated from GET /api/v1/tags),
                                  "N active, clear filters"
src/api/client.ts                apiRequest() — the one fetch wrapper every other api/*
                                  client builds on; VITE_API_BASE_URL, never a hardcoded
                                  hostname; apiUrl() resolves API-relative asset paths
src/api/authClient.ts            the OAuth code exchange, refresh, logout, /me
src/api/manageClient.ts          submit, preview-check, my-layouts CRUD, submitAsset (#101)
src/api/moderationClient.ts      moderation browse + read-only admin user directory
src/api/types.ts                 hand-written against services/api/src/layouts/schemas.ts
src/api/useApi.ts                loading/error/ready as data, for every screen that calls
                                  the API
src/auth/AuthProvider.tsx        the session state machine — see below
src/auth/authState.ts            the auth context and useAuth(), split out for the same
                                  reason as themeState.ts
src/auth/storage.ts              only the refresh token is persisted; see docs/ARCHITECTURE.md
src/routes/filters.ts            the URL <-> Filters <-> API params translation — the
                                  URL is the shareable, human-readable form; the API's own
                                  min/max params are what's actually sent
src/routes/Home.tsx              the gallery: FilterBar wired to useSearchParams, keyset
                                  pagination via the API's cursor, "Load more", a
                                  filter-aware empty state
src/routes/LayoutDetailPage.tsx  live/static office, formatted layout.json, full metadata,
                                  revision warning, clickable tags/author
src/routes/AuthorPage.tsx        public author identity and all of their public layouts
                                  and custom assets
src/routes/assetFilters.ts      the URL <-> AssetFilters <-> API params translation for
                                  /assets — deliberately smaller than filters.ts: the API
                                  supports only category/author, no sort or search, and
                                  this only ever offers exactly that
src/routes/AssetsGallery.tsx    the custom-asset gallery, same shape as Home.tsx
src/routes/AssetDetailPage.tsx  a custom asset's sprite, metadata, and an "Open in
                                  editor" link — never gated: every published asset is
                                  already in the editor's palette (live-office/assets.ts)
src/routes/AssetSubmitPage.tsx  zip upload + name/category (#101) — no pre-publish
                                  preview; that needs the real engine's rendering logic
                                  and is #102's job
src/components/AssetFilterBar.tsx  the /assets equivalent of FilterBar.tsx
src/components/AssetCard.tsx    the /assets equivalent of LayoutCard.tsx
src/live-office/                isolated iframe entry: thin wrapper around the pinned
                                  OfficeState/OfficeCanvas/ToolOverlay renderer, and —
                                  driven by the same postMessage protocol — the editor
src/routes/LayoutEditorPage.tsx  the editor's chrome: which layout to load, importing one,
                                  and whether it ends at /submit or replaces an existing
                                  layout
src/components/SubmissionGate.tsx
                                  "members of the Discord community only", shared by
                                  /submit and the editor
build/liveOfficeAssets.ts       build-time upstream sprite decode, content-addressed by pin
e2e/live-preview.mjs            production-build Chromium guard for upstream pin changes
src/routes/SubmitPage.tsx        paste/upload layout.json, "Check preview" before "Publish"
src/routes/MyLayoutsPage.tsx     list/edit/replace/delete what you own, visibility + reason
src/routes/ModerationPage.tsx    every layout, any visibility; hide/remove/restore with a reason
src/routes/AdminPage.tsx         read-only users/capabilities/layout-count directory
src/routes/DeveloperPage.tsx     public, unauthenticated: GET /'s version/commit/repo
                                  link, plus a reference generated by reading GET
                                  /openapi.json directly — not an embed of the API's own
                                  Swagger UI, which stays linked as "Interactive docs"
src/api/openapi.ts               loose OpenAPI-document types + describeSchema()/
                                  bodyFields() the DeveloperPage reference renders from
vite.config.ts                   base path, multi-page live-office build + Pages fallback
index.html                       the matching restore-path script (see the two together)
```

### The session: the bearer-token design, implemented

`auth/AuthProvider.tsx` is the state machine the bearer-token design (see
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md#how-they-talk-to-each-other) for why
it's a bearer token and not a cookie) turns into — worth reading alongside that doc, not
instead of it. On mount: if the URL has a `#pixelIndexLoginCode=...` fragment (the redirect back
from Discord landed here), it's exchanged immediately and cleared from the address bar
before the app ever renders with it visible; otherwise a stored refresh token (if any)
is used to restore a session via `/auth/refresh` then `/me`. The access token lives in
React state only — memory, never `localStorage` — while the refresh token is persisted
(`auth/storage.ts`) so a page reload doesn't force a full Discord round-trip. A timer
proactively rotates the access token about a minute before it expires; any refresh
failure (reuse detected or expired) clears the session rather than retrying. While the
page is visible, `/me` is also polled at the Discord capability-cache interval and on
window focus so a Discord role or membership change reaches navigation promptly.

`RequireAuth` (and the nav links it mirrors) is UX, not authorization: every page it
gates makes the exact same API calls a logged-out `curl` could make, and gets the exact
same 401/403 back. Hiding a "Moderation" link from a normal user makes the product
legible; it does nothing for security, which is the API's job alone.

### The editor is the viewer, in edit mode — and it stays in the iframe

`/editor` (#65) does not implement office editing. Upstream already ships all of it:
`hooks/useEditorActions.ts` is the controller (undo/redo, dirty tracking, every canvas
callback), `office/editor/EditorToolbar.tsx` is the palette, `office/editor/
editorActions.ts` the operations. `live-office/PreviewApp.tsx` used to pass
`isEditMode={false}` and six no-ops to a canvas that could already do all of this; it now
passes upstream's real handlers when the parent asks for an editor.

It stays inside the `live-office.html` frame for a concrete reason, not for symmetry with
the preview. `EditorToolbar` and the UI primitives it uses are styled from upstream's
Tailwind theme, whose `@theme inline` block defines `--color-accent`, `--color-border`,
`--color-danger` and `--color-warning` — the same token names `src/index.css` defines for
this site, in hardcoded dark-only values. `live-office/viewer.css` can import that theme
wholesale precisely because the frame is a separate document; importing it into the app
bundle would repaint the gallery and break light mode.

So the parent and the frame split along what each can know: the page owns who may edit,
which layout to load, and where the result goes; the frame owns the layout and emits it
(`layout` messages, debounced) as the exact bytes that would be published. One producer
of those bytes, no divergence.

**A layout drawn here needs a `layoutRevision` stamped on it.** Upstream never writes that
field — a layout inherits it from the bundled default it descends from, and
`createDefaultLayout()` (the blank room) has none, which reads as `0`. `layout-core`
rejects anything below the bundled revision, so a blank layout would be drawn, previewed,
and then refused at publish with a message telling the author to re-export from Pixel
Agents — which is not something the author of a layout drawn *here* can do. The page
therefore passes the revision from `GET /api/v1/meta` (the API's own pin, which under #64
can differ from this build's) and the frame stamps it, never downwards. `npm run test:e2e`
draws a layout from the blank room in Chromium and runs `validateLayout` over the result,
which is the check that would catch this regressing.

### CORS needs an explicit methods list

Without an explicit `methods` list, `@fastify/cors` derives a preflight's
`Access-Control-Allow-Methods` header from route introspection, which only ever
produces `GET, HEAD, POST` — every `PATCH`/`PUT`/`DELETE` call (edit, replace, delete,
moderate) is silently blocked by the browser before it reaches the server.
`services/api/src/server.ts` sets an explicit, path-independent methods list instead. A
route existing in Fastify and a route being *reachable from a browser* are different
claims, and only a real browser preflight — not the unit suite — proves the second one.

### Filters live in the URL, not component state

`routes/filters.ts` is the one place that translates between three shapes: the URL's
query string (`?minSize=100&tags=cosy,small` — readable, shareable, what a pasted link
looks like), the `Filters` object components work with, and the API's own query
parameters (`minCols`/`maxCols`/`minRows`/`maxRows`, `minSize`/`maxSize`,
`minPets`/`maxPets`, …). `Home.tsx` derives `filters` from `useSearchParams()` on every
render rather than holding its own copy in `useState` — the URL *is* the state, so the
browser back button, a bookmark, and a pasted link all just work, with no separate
synchronization code to keep them aligned.

**Size is filtered by tile count, not by cols/rows independently.** `minSize`/`maxSize`
filter on the product, computed server-side in `query.ts`.

That product is `visibleCols * visibleRows` — the *occupied footprint* — not
`cols * rows`, the declared canvas. `cols`/`rows` is a fixed allocation shared
across many layouts (furniture placement needs a stable canvas to be absolute against),
so three seed layouts can — and did — declare the identical 21×22 canvas while looking
nothing alike. `visibleCols`/`visibleRows` is the bounding box of every non-VOID tile,
computed once in `@pixel-index/layout-core`'s `layoutStats()` and denormalised onto the
row exactly like `seats` is; it is what `facts.ts` displays, what `largest` sorts by,
and what `minSize`/`maxSize` filters on.

### The tag picker never offers a filter guaranteed to return nothing

`GET /api/v1/tags` (`services/api/src/layouts/query.ts`) returns only tags actually used
by a **public** layout, with a count, most-used first. `FilterBar` hides the tag picker
entirely when that list is empty, rather than rendering a picker with nothing in it — a
real risk on a fresh install with no tags yet.

### No "report" control

There is no in-app report button — this index has no report-intake queue (no
`POST /report`), so there is nothing for a report button to call. `docs/CONTENT_POLICY.md`
documents the actual path: contact a moderator directly.

## Constraints that come with static hosting

- **No secrets, ever.** Anything in this bundle is public. The Discord client secret and
  every authorization decision live in `services/api`.
- **No hostnames in source.** The API base URL is `VITE_API_BASE_URL`, build-time config
  with a documented local-dev default (`.env.example`) — never baked in for production,
  so self-hosters never inherit an owner's own deployment.
- **Deep links need help.** Pages has no rewrite rules. Chosen: the `404.html` fallback
  (`vite.config.ts`'s `ghPagesSpaFallback` plugin + `index.html`'s restore script,
  <https://github.com/rafgraph/spa-github-pages>), not hash routing — clean URLs
  (`/layouts/some-office`, not `/#/layouts/some-office`) matter more here than avoiding
  one redirect hop on an already-rare hard-refresh-on-a-deep-link case. Vercel needs
  none of this: it has real rewrite rules (`vercel.json`), so the plugin is a no-op there.
- **The site is only as available as the API.** Loading, empty and error states are
  first-class (`api/useApi.ts`), which the v1 static site never had to consider — an
  unreachable API renders a message, not a blank page.
- **The live office is build-time pinned.** It is not an iframe to an external service and
  it never contacts the internal renderer. Vite compiles selected Pixel Agents modules and
  decodes its sprites into immutable JSON sidecars keyed by `vendor/pixel-agents.commit`.
  The iframe isolates upstream's Tailwind/base styles from the gallery SPA — which is also
  why the editor lives there (see above). Run `npm run test:e2e` in this workspace to build
  the Pages-subpath bundle and exercise the pinned default layout, canvas pixels, activity
  panels, controls and persistence in Chromium, then draw and validate a layout in the editor.

## Deploys

- **Production**: `.github/workflows/pages.yml` checks out the pinned submodule and builds this workspace on every push to
  `main` and deploys it to GitHub Pages. `VITE_BASE_PATH` is set automatically to
  `/<repo-name>/` (a GitHub Pages project site's URL shape); `VITE_API_BASE_URL` comes
  from the repo's `PRODUCTION_API_BASE_URL` Actions variable — unset until the API has a
  real production host, in which case the deployed site's calls fail with a clear
  "unreachable" message rather than trying `localhost`.
- **PR previews**: a Vercel project with Root Directory `apps/web` (`vercel.json` handles
  installing/building from the monorepo root). Every PR gets a preview URL commented by
  Vercel's own GitHub integration — no custom GitHub Action or token needed for this
  part. `VITE_BASE_PATH` is unset (Vercel serves from the domain root); point
  `VITE_API_BASE_URL` at a non-production API via a Vercel Environment Variable if/when
  one exists.

## Design tokens: lifted, not invented

`src/index.css` defines every colour and the display font as CSS custom properties
(`--pi-*`), fed into Tailwind v4 via `@theme inline` so they're ordinary utility classes
(`bg-surface`, `text-accent`, `border-danger`, `font-display`, …) everywhere else in the
tree — no component hand-mixes a colour.

- **Preview backdrop**: a plain `bg-canvas` fill with `image-rendering: pixelated`, so
  the renderer's pixel art stays crisp instead of browser-smoothed.
- **Accent (`#6030ff` family)** and the **light/dark split** come from the Pixel Agents
  docs site's own `src/css/custom.css` (`pixel-agents-hq/docs`) — its
  `--ifm-color-primary*` scale and its `html[data-theme='dark']` emphasis scale.
- **Dark-mode surface tones** (`#1e1e2e`, `#16162a`) are the office webview's own
  (`vendor/pixel-agents/webview-ui/src/index.css`).
- **`FS Pixel Sans`** is the same bitmap font both the office and the docs site use for
  headings — copied into `public/fonts/` (MIT, from the pinned submodule) so the public
  asset remains explicit.
- **Contrast**: every canvas/ink/muted/accent pairing was checked against WCAG AA
  (4.5:1) with the office/docs hexes as fixed points; two of the docs' own tones
  (`muted`, `subtle` in light mode) needed darkening a step to clear it — see the
  comments beside those tokens in `index.css` for the exact ratios.
- **Theme toggle**: `theme/ThemeProvider.tsx`, defaulting to the OS preference,
  persisted to `localStorage` (`pixelindex_theme`) — `index.html` applies it in an
  inline script before the app bundle loads, so there's no flash of the wrong theme.
- **Favicon / social preview**: `public/favicon.svg` (hand-written) and
  `public/og-image.png` (rendered with Playwright from a small HTML page using the same
  tokens) — both an accent-grid mark on the office's own solid dark surface, so the
  brand is consistent from a browser tab to a Discord embed to a preview card.
