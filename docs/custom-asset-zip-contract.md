# Custom-asset upload zip contract

`POST /api/v1/assets` (#101, #105) accepts a zip file and detects its `assetKind`
(`furniture` | `character` | `pet`) from the zip's own contents — the caller does not
declare it (#105 follow-up). This document is the producer-side contract for each kind's
shape — everything a tool generating these zips (starting with
[pixel-art-mcp](https://github.com/NNTin/pixel-art-mcp)) needs to know to build one that
pixel-index will accept, without reverse-engineering
`services/api/src/assets/{decode.ts,decodeCharacter.ts,decodePet.ts,manifest.ts}`.

It documents what is already accepted, and does not change the zip format. All three
manifest schemas below are also what `manifest.ts`/`decodeCharacter.ts`/`decodePet.ts`
actually compile and run at upload time (via `ajv`) — not a separate hand-written check
that could drift from the published contract. A test
(`services/api/src/assets/customAssetContract.test.ts`) additionally validates this
repo's own fixture builders against the schemas, so a fixture the decode logic genuinely
accepts can never quietly stop matching what's published here.

## Pinning: how to consume this contract

**Pin to a commit SHA of this repository, never to a branch.** Fetch the schema files at
that pin, e.g.:

```text
https://raw.githubusercontent.com/pixel-agents-hq/index/<commit-sha>/packages/layout-core/schema/custom-asset-furniture-manifest.schema.json
https://raw.githubusercontent.com/pixel-agents-hq/index/<commit-sha>/packages/layout-core/schema/custom-asset-pet-manifest.schema.json
https://raw.githubusercontent.com/pixel-agents-hq/index/<commit-sha>/packages/layout-core/schema/custom-asset-character-manifest.schema.json
```

(or vendor them via a git submodule pinned to that same SHA — the mechanism this repo
itself uses for its own upstream dependency on `pixel-agents`, see `vendor/pixel-agents`
and `tools/vendor-commit.mjs`).

This is a plain committed-files approach, not an npm package, for two reasons:

- **The schema's own home, `@pixel-index/layout-core`, is `"private": true` and has never
  been published to a registry** — there is no existing publish pipeline to hang a
  version on, and building one only for this would be new infrastructure nobody has
  asked to maintain yet. As of this writing nothing outside this repo pulls from
  `packages/layout-core/schema/` — this is the first cross-repo consumer of it.
- **The actual consumer, pixel-art-mcp, is a Python project** (`pyproject.toml`, no
  Node/npm anywhere in it). An npm package would need a second, entirely separate
  distribution channel to reach it anyway; a plain JSON Schema file fetched by URL is
  usable from any language and needs none.

A commit SHA is a stronger pin than a git tag would be for this monorepo specifically:
this repo has no release-tagging convention today (compare `vendor/pixel-agents`, which
pins pixel-index's own upstream dependency the same way — a raw commit SHA in
`vendor/pixel-agents.commit`, not a tag), so introducing tags just for this contract
would be new process for no more precision than the commit SHA already gives. It
satisfies pixel-art-mcp#8's stated requirement directly: "pinned to a version/commit
(not floating)" — a commit SHA is exactly that, and unlike a floating branch reference
it can never change out from under a consumer that already pinned it.

### Live discovery — `GET /api/v1/assets/schema/{kind}`

A running instance also serves these same schemas live, unauthenticated (`kind` is
`furniture`, `pet`, or `character`):

```text
GET /api/v1/assets/schema/furniture
GET /api/v1/assets/schema/pet
GET /api/v1/assets/schema/character
```

The response body **is** the schema document itself — feed it straight to a validator
(`ajv.compile(await response.json())`) without unwrapping an envelope first. This is
**for discovery and live drift-checking, not a substitute for pinning**: it always
serves whatever schema the instance you asked is actually running right now, which for
staging/production is exactly the point (catching the specific case pinning can't — a
deploy whose behavior moved but whose committed schema didn't) but is the opposite of a
pin for anything checked into a consumer's own repo. Use the pinned-commit files above
for that; use this endpoint to check them against what a real instance is doing.

`/api/v1/assets/schema/:kind` is also automatically part of `GET /openapi.json` (this
project's OpenAPI spec is generated from the registered Fastify routes), so the schema
files are one link away from the same spec pixel-art-mcp already reads for the rest of
this API's shape.

## Kind detection

`assetKind` is not a request parameter — pixel-index tries each kind's decoder in turn
(furniture, then character, then pet) and uses whichever one the zip's contents actually
satisfy. Furniture's manifest schema is structurally distinct (`category`/`type`/
`members`), so it's tried first and fails fast on a genuine furniture upload with a bad
manifest. Character and pet share the same minimal `{id, name}` manifest shape, so
between those two the decisive signal is the PNG itself — its dimensions and frame
layout — not the manifest.

## Furniture (detected as `assetKind: "furniture"`)

- A `manifest.json` located **anywhere** in the zip (root or nested — e.g.
  `assets/furniture/<ASSET_ID>/manifest.json`, pixel-art-mcp's own current export
  shape). PNGs referenced by the manifest's `file` field are resolved **relative to
  manifest.json's own directory**, not the zip root.
- **Both a flat root-level layout and a nested `assets/furniture/<ID>/` layout are
  valid, deliberately** — this is not an inconsistency to fix. `decodeFurnitureZip`
  finds `manifest.json` by name wherever it is and resolves everything else relative to
  that directory, specifically so it accepts the exact shape pixel-art-mcp's own
  `pixel_agents` export option already produces with **no translation layer** between
  what pixel-art-mcp ships and what pixel-index accepts (see `decode.ts`'s own header
  comment, and issue #101). A generator may use either layout; this contract does not
  prefer one over the other.
- Manifest schema:
  [`packages/layout-core/schema/custom-asset-furniture-manifest.schema.json`](../packages/layout-core/schema/custom-asset-furniture-manifest.schema.json).
  Covers the `category` enum and the recursive `asset`/`group` node shape
  (rotation/state/animation groups). `category` is **not a fixed list** — it's
  generated (`tools/generate-furniture-categories-schema.mjs`) from the categories
  the pinned vendor's real bundled furniture manifests actually use, so it can change
  across a vendor bump. Fetch `GET /api/v1/assets/schema/furniture` from a running
  instance for the live enum rather than hardcoding one.
- PNG dimensions are **per-manifest**, not fixed: each `asset` node declares its own
  `width`/`height`, and the uploaded PNG must match those exactly (`decodePng` in
  `zip.ts` rejects a mismatch rather than silently misreading the buffer).

## Character (detected as `assetKind: "character"`)

- `manifest.json` + one PNG alongside it (the "manifest.json anywhere, resolve everything
  else relative to its directory" rule furniture and pet both use).
- Manifest schema:
  [`packages/layout-core/schema/custom-asset-character-manifest.schema.json`](../packages/layout-core/schema/custom-asset-character-manifest.schema.json)
  — just `{ id, name }`, structurally identical to the pet manifest. Upstream itself has
  no id/name for a character at all; pixel-index keeps both purely for its own identity
  (`GET /api/v1/assets/:assetId`) and to avoid asking an uploader to retype a name that
  isn't otherwise anywhere in the zip.
- **A pet manifest and a character manifest are indistinguishable by shape alone** — kind
  detection instead relies on each decode module's own PNG dimension/layout check (a
  112×96 single-pose sheet vs. a 96×96 frame grid); see the "Kind detection" note below.
- Exactly one PNG alongside the manifest.
- PNG must be exactly **112×96 pixels**.
- Frame grid (source of truth: `vendor/pixel-agents/core/src/assets/constants.ts` +
  `pngDecoder.ts`'s `decodeCharacterPng`, pinned at commit
  [`3537e14`](https://github.com/pixel-agents-hq/pixel-agents/commit/3537e140c2094761beae748592aeb92ece8edfdd)):
  - 3 direction rows, top to bottom: `down`, `up`, `right` (`CHARACTER_DIRECTIONS`).
    Each row is `CHAR_FRAME_H = 32` px tall → 3 × 32 = **96**.
  - 7 frame columns per row (`CHAR_FRAMES_PER_ROW = 7`), each `CHAR_FRAME_W = 16` px
    wide → 7 × 16 = **112**.
  - `left` is not a row — it's derived at render time by horizontally flipping `right`.

## Pet (detected as `assetKind: "pet"`)

- One directory containing exactly `manifest.json` and one PNG alongside it (the
  directory's own name is not part of the contract — pixel-index reads whichever
  directory `manifest.json` is found in, the same "manifest.json anywhere, resolve
  relative to its directory" rule furniture uses).
- Manifest schema:
  [`packages/layout-core/schema/custom-asset-pet-manifest.schema.json`](../packages/layout-core/schema/custom-asset-pet-manifest.schema.json)
  — just `{ id, name }`. Upstream itself drops `id` once a pet reaches the client; only
  `name` and array index matter downstream there. Pixel-index keeps `id` anyway, for its
  own `GET /api/v1/assets/:assetId`.
- PNG must be exactly **96×96 pixels**.
- Frame grid (same upstream source, `decodePetPng`, same pinned commit):
  - Row 0 (`y = 0..32`): 6 frames × 16 px wide — `walkDown[0..2]` then `idleDown[0..2]`.
  - Row 1 (`y = 32..64`): 6 frames × 16 px wide — `walkUp[0..2]` then `idleUp[0..2]`.
  - Row 2 (`y = 64..96`): 3 frames × 32 px wide — `walkRight[0..2]`.
  - `walkLeft`/`idleLeft` are not rows — derived at render time by horizontally
    flipping the `right`/... equivalents.
- **Enforced by pixel-index**: `decodePetZip` rejects a pet PNG over 512 KiB
  (`MAX_PET_PNG_BYTES`), mirroring upstream's own external-pet loader's
  `MAX_PET_PNG_SIZE = 512 KiB` (`constants.ts`) — tighter than, and checked in addition
  to, the whole-zip `MAX_ASSET_ZIP_BYTES` cap (5 MB by default,
  `services/api/src/config.ts`). Without this, a pet PNG between 512 KiB and 5 MB would
  upload successfully here and then fail to load once a user pointed their own
  pixel-agents install at it — the exact drift this contract exists to catch before
  upload rather than after.

## What this contract does not cover

- Cross-field/semantic rules that depend on server state (id collisions, capability
  gating) — those live in `services/api/src/assets/*.ts` and are not expressible in a
  JSON Schema.
- Character's PNG-only rule, and every kind's PNG dimension/frame-grid check, are still
  imperative code (`decodeCharacter.ts`, `decodePet.ts`, `zip.ts`'s `decodePng`), not
  JSON Schema — JSON Schema has no way to express "decode this referenced binary and
  check its pixel dimensions."
