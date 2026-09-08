# @pixel-index/layout-core

The single definition of what a valid layout is.

Three components need this answer — CI, the API's submission endpoint, and the renderer
— and three copies would drift. A drifted validator means the index accepts a layout
that Pixel Agents will silently discard.

The library takes **parsed objects, never paths**, so a server can validate an uploaded
request body directly. Reading the *pinned upstream* from disk is the one exception: the
furniture catalog and the bundled `layoutRevision` have to come from somewhere.

## Two layers

| Layer | Mechanism | Catches |
|---|---|---|
| Structure | JSON Schema (`schema/`) | types, required fields, ranges |
| Semantics | code (`validateLayout`) | cross-field and upstream-dependent rules |

The split is forced: a schema cannot express `tiles.length === cols * rows`, and it
cannot know which furniture ids the pinned Pixel Agents can draw or what its bundled
`layoutRevision` is.

## Surface

```ts
import { createValidator, layoutStats, sha256 } from '@pixel-index/layout-core';

// Reads the upstream catalog once — never do this per request.
const validator = createValidator({ upstreamVersion: '1.4.0' });

const { valid, issues } = validator.validateLayout(uploadedLayout);
// issues: [{ code: 'layout.revision.below_bundled', path: '/layoutRevision', message: '…' }]
```

| Export | Purpose |
|---|---|
| `createValidator(opts)` | catalog + revision loaded once, then validate many |
| `validateLayout(layout, opts)` | structure and semantics |
| `validateMeta(meta)` | schema-driven |
| `validateSlug(slug)` | lowercase kebab-case |
| `layoutStats(layout, opts?)` | cols, rows, furniture, areas, pets, carpets, seats, layoutRevision |
| `furnitureCatalog(dir?)` / `knownFurnitureIds(dir?)` | what the pinned upstream can draw |
| `mergeFurnitureCatalog(base, extra)` | extends a catalog with more entries (#101's custom, uploaded furniture) — a cheap `Map` copy, not a re-read of the upstream asset tree |
| `bundledLayoutRevision(dir?)` / `upstreamPin(dir?)` | the pinned upstream's facts |
| `sha256(input)` | dedupe and render-cache keys |
| `layoutSchema` / `metaSchema` | the raw schemas, for serving and for 422 bodies |

Issues are returned as data, never printed and never thrown, so the API can render them
as a 422 and the CLI can format them for a terminal.

`layoutStats` is the source of truth for the denormalised database columns: they are
written from here on every insert and update, so a stat in the gallery cannot disagree
with the layout beside it.

## Locating the pinned upstream

`resolveUpstreamDir()` takes an explicit argument, then `PIXEL_AGENTS_DIR`, then walks
up looking for `vendor/pixel-agents`. Walking up rather than hardcoding a relative path
keeps it working from `src/` under vitest, from `dist/` after a build, and from wherever
npm hoists the package inside a container — which is why every upstream function accepts
a directory instead of using a constant.

## CLI

```bash
npm run validate                                  # from the repo root, over seed/
node packages/layout-core/dist/cli.js <dir>       # any directory of <slug>/ folders
```

The CLI owns the on-disk convention (`<dir>/<slug>/{layout,meta}.json`) and the terminal
formatting, and nothing else — that convention belongs to the git-versioned seed
(`seed/`), which is exactly why it lives in the CLI rather than in the library.

## The rule that eats layouts

Pixel Agents **discards a stored layout whose `layoutRevision` is lower than the bundled
default's** (`vendor/pixel-agents/server/src/layoutPersistence.ts`) and resets to the
default. A layout published below the current revision silently disappears from the
user's office on next start, so this is an **error, never a warning**, and its message
explains the consequence rather than just refusing.

## Two false positives, permanently pinned by tests

Both appear in real published layouts — `parity.test.ts` re-proves them against `seed/`
on every run, and guards that the data still exercises them:

- **Virtual `:left` furniture ids.** Upstream synthesises entries like `PC_SIDE:left`
  for assets with `mirrorSide` and `orientation: "side"`, and layouts store that id
  verbatim. A catalog reader that only walks declared ids reports valid furniture as
  unknown.
- **Wall furniture at negative rows.** Wall-mounted items are anchored by their *bottom*
  row (`getWallPlacementRow: row - (footprintH - 1)`), so a 2-tall `CLOCK` on the top
  wall legitimately sits at row `-1`. The valid lower bound is
  `canPlaceOnWalls ? -(footprintH - 1) : 0`, not `0`.

## Tests

```bash
npm test --workspace @pixel-index/layout-core
```

They run against the **real pinned submodule** rather than a fixture catalog, on
purpose: the value of this package is that it agrees with the upstream actually shipped,
and a mocked catalog would prove nothing about that.
