# Custom-asset upload zip contract

`POST /api/v1/assets` (#101, #105) accepts a zip file whose internal shape depends on
`assetKind` (`furniture` | `character` | `pet`). This document is the producer-side
contract for that shape — everything a tool generating these zips (starting with
[pixel-art-mcp](https://github.com/NNTin/pixel-art-mcp)) needs to know to build one that
pixel-index will accept, without reverse-engineering
`services/api/src/assets/{decode.ts,decodeCharacter.ts,decodePet.ts,manifest.ts}`.

It documents what is already accepted. It does not change the zip format, and it is not
enforced at runtime by the decode modules above — see
[#107](https://github.com/pixel-agents-hq/index/issues/107) for why (a runtime rewrite is
a deliberate later step, not required to publish the contract itself). A test
(`services/api/src/assets/customAssetContract.test.ts`) validates this repo's own
fixture builders against the schemas below, so this document and the schemas can't
silently drift from the decode logic that actually enforces the format.

## Pinning: how to consume this contract

**Pin to a commit SHA of this repository, never to a branch.** Fetch the schema files at
that pin, e.g.:

```text
https://raw.githubusercontent.com/pixel-agents-hq/index/<commit-sha>/packages/layout-core/schema/custom-asset-furniture-manifest.schema.json
https://raw.githubusercontent.com/pixel-agents-hq/index/<commit-sha>/packages/layout-core/schema/custom-asset-pet-manifest.schema.json
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

## Furniture (`assetKind=furniture`)

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
  Covers the 7-value `category` enum (`desks`, `chairs`, `electronics`, `storage`,
  `decor`, `misc`, `wall` — kept as-is for upstream parity, #105) and the recursive
  `asset`/`group` node shape (rotation/state/animation groups).
- PNG dimensions are **per-manifest**, not fixed: each `asset` node declares its own
  `width`/`height`, and the uploaded PNG must match those exactly (`decodePng` in
  `zip.ts` rejects a mismatch rather than silently misreading the buffer).

## Character (`assetKind=character`)

No `manifest.json` — characters are identified purely positionally upstream (no id or
name at all), so a manifest would have nothing correct to put in it. **A zip containing
a `manifest.json` is rejected outright**, not treated as an optional extra.

- Exactly one PNG in the zip.
- PNG must be exactly **112×96 pixels**.
- Frame grid (source of truth: `vendor/pixel-agents/core/src/assets/constants.ts` +
  `pngDecoder.ts`'s `decodeCharacterPng`, pinned at commit
  [`3537e14`](https://github.com/pixel-agents-hq/pixel-agents/commit/3537e140c2094761beae748592aeb92ece8edfdd)):
  - 3 direction rows, top to bottom: `down`, `up`, `right` (`CHARACTER_DIRECTIONS`).
    Each row is `CHAR_FRAME_H = 32` px tall → 3 × 32 = **96**.
  - 7 frame columns per row (`CHAR_FRAMES_PER_ROW = 7`), each `CHAR_FRAME_W = 16` px
    wide → 7 × 16 = **112**.
  - `left` is not a row — it's derived at render time by horizontally flipping `right`.

## Pet (`assetKind=pet`)

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
- **Not enforced by pixel-index, but worth knowing**: upstream's own external-pet loader
  caps a pet PNG at `MAX_PET_PNG_SIZE = 512 KiB` (`constants.ts`). Pixel-index's own
  upload path only caps the *whole zip* (`MAX_ASSET_ZIP_BYTES`, 5 MB by default,
  `services/api/src/config.ts`) — a pet PNG under 5 MB but over 512 KiB would upload
  successfully here and then fail to load once a user points their own pixel-agents
  install at it. A generator aiming for genuine end-to-end compatibility, not just a
  successful upload, should self-limit to 512 KiB per pet PNG.

## What this contract does not cover

- Cross-field/semantic rules that depend on server state (id collisions, capability
  gating) — those live in `services/api/src/assets/*.ts` and are not expressible in a
  JSON Schema.
- Runtime validation: pixel-index's own decode modules still enforce this shape with
  their own imperative checks, not by compiling these schemas. That is a deliberate,
  separate follow-up (see #107's "explicitly out of scope").
