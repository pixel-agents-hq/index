---
name: advance-vendor
description: Move the vendored pixel-agents pin (vendor/pixel-agents) to a newer upstream commit. Covers diagnosing what the bump breaks, fixing it on the index side first, opening an upstream pixel-agents PR only when the index genuinely cannot cope alone (via the nntin-bot fork, with a CI mirror PR inside the fork), watching CI in both repos, and closing whatever the bump supersedes. Use for any "bump / update / advance pixel-agents" task, including taking over or replacing the automated vendor-update PR.
---

# Advancing the vendored pixel-agents

`vendor/pixel-agents` is a git submodule tracking `pixel-agents-hq/pixel-agents`
`main`. The index compiles parts of its sources directly (the live layout viewer
mounts `OfficeCanvas`, `EditorToolbar`, ... in `apps/web/src/live-office/`) and
drives its full App headlessly (`services/renderer`). So an upstream bump can
break the index even when upstream itself is green. Low commit counts mean
nothing: the 1.4.1 → 1.5.0 bump was 6 commits and 172 files.

## The rule that matters most: fix it in the index unless you can't

**Pin plain upstream `main` whenever possible.** Every upstream PR you open
costs a lot. #127 can't merge before the upstream PR does. The pin points
at a commit that exists only on a PR branch. The scheduled `vendor-update.yml`
runs `git submodule update --remote`, tracks `main`, and drops your fix on
every daily run until upstream adopts it. And the upstream maintainers carry
API surface for a single consumer.

Before proposing any upstream change, write down why the index can't handle it
alone, and try the index-side options first:

| Upstream change | Do this in the index | Don't |
| --- | --- | --- |
| Renamed / re-shaped props, hooks, fields (`onDragMove` → `onDrop`, `selectedFurnitureType` → `placingType`, `workspaceFolders` → `directories`) | Migrate the index's call sites to the **new** names | Add legacy / `@deprecated` aliases upstream. The owner rejected this, and the repo's `@typescript-eslint/no-deprecated` lint rule fails on them anyway |
| New required prop (`onColorPickToggle`) | Pass it, wired to upstream's own handler | Make it optional upstream |
| New third-party import in upstream source the index compiles (`@material-symbols/font-700` in `index.css`) | Add the same version range to `apps/web/package.json` (as `tailwindcss` / `react` already are). Docker and Vercel never install the submodule's `node_modules` (see `apps/web/Dockerfile`) | Move the import upstream |
| Behaviour keyed on the environment the index controls (#404's mobile shell at `max-width: 768px` vs the renderer's layout-sized viewport) | Change the environment: `renderGeometry()` floors the viewport at 769px | Add an opt-in flag upstream |

An upstream PR is justified only when the index cannot reach the behaviour
from outside at all, e.g. a bug in code the index must run unmodified. If
you're unsure, put the reasoning to the user before opening one. "The fix
belongs upstream" is a scoping preference, not a reason.

## Procedure

### 1. Sync and scope

```bash
git fetch origin develop && git checkout -B <branch> origin/develop   # develop may be checked out elsewhere
git submodule update --init vendor/pixel-agents
git -C vendor/pixel-agents fetch origin
git -C vendor/pixel-agents log --oneline <pin>..origin/main
git -C vendor/pixel-agents diff --shortstat <pin> origin/main
```

Check for an open automated PR (`chore/vendor-pixel-agents`, opened by
`vendor-update.yml`) for the same range. Yours will supersede it (step 6).

Check whether the asset / sprite format moved:
`git -C vendor/pixel-agents diff --stat <pin> origin/main -- webview-ui/public/assets core/src/assets`.
If it did, update the hand-kept mirrors that say so
(e.g. `services/api/src/assets/decodeCharacter.ts`'s frame-grid constants,
`services/api/src/soundtracks/songCode.ts`'s copy of the radio's song-code format;
`songCode.test.ts` compares it with upstream's own parser).

### 2. Run the real harness (don't build a new one)

Reproduce `.github/workflows/vendor-update.yml` locally, in its order. All
of it goes through `npm` / `npx`, so it already enters the shared heavy-job
queue. Run one step at a time.

```bash
npm ci && npm run build:core
H=services/renderer/src/harness/cli.ts
# baseline at the current pin
(cd vendor/pixel-agents && npm ci)
npx tsx $H run --source seed --out gate/seed-baseline.json
npx tsx $H run --source seed --seed-dir seed-custom-assets --out gate/custom-assets-baseline.json
npx tsx $H run --source api --api-url "$(gh variable get PRODUCTION_API_BASE_URL)" --out gate/live-baseline.json
# move the pin
git -C vendor/pixel-agents checkout <candidate>
git -C vendor/pixel-agents rev-parse HEAD > vendor/pixel-agents.commit
(cd vendor/pixel-agents && npm ci)
npm run test:e2e --workspace @pixel-index/web          # live layout viewer: production build + Chromium
npx tsx $H run --source seed --out gate/seed-candidate.json --png-dir gate/png/seed   # same for the other two sources
npx tsx $H diff --baseline gate/seed-baseline.json --candidate gate/seed-candidate.json \
  --gate "Seed gate" --report gate/seed-report.md --manifest gate/seed-manifest.json \
  --upstream-url https://github.com/pixel-agents-hq/pixel-agents
```

**"Renders differently" isn't a pass.** The gate fails only on layouts that
stop rendering. A shifted or cropped office passes as "renders differently".
Render baseline PNGs too (`--png-dir` at the old pin) and diff the pixels.
Expect 0 changed pixels, except fixtures with wandering pets (`seed-custom-assets/pet`).
Confirm a diff is noise by rendering the *same* candidate twice and comparing
`pngSha256`.

Also reproduce the container builds: move `vendor/pixel-agents/node_modules`
(and `webview-ui/node_modules`) aside, run `npm run build --workspace @pixel-index/web`,
then restore them. Your local submodule install hides missing dependencies.

Things that looked suspicious but held at 1.5.0 (re-check them, cheaply):
`apps/web/build/liveOfficeAssets.ts` aliases every `*/transport/index.js`
import to the inert `src/live-office/transport.ts`, so upstream's real transport
(`connect()`, `serverToken.ts`) never ships. Verify every importer still uses
that specifier, and grep the built `dist/assets/*.js` for `new WebSocket`.

### 3. Fix on the index side, then verify everything

`npm run typecheck`, `npm run lint` (root; type-aware, includes
`no-deprecated`), `npm test --workspace @pixel-index/web`,
`services/renderer` `npm test` + `npm run test:integration`,
`npm run vendor:commit:check`, `npm run furniture-categories:schema:check`,
`npm run builtin-profiles:check` (if it fails, the default cast or its wardrobe art
moved: run `npm run builtin-profiles` and commit the regenerated
`services/api/src/assets/builtinProfiles.json`), then
the step-2 harness again at the final pin. Commit the gitlink and
`vendor/pixel-agents.commit` together (CI's drift check fails otherwise).

The avatar package (`packages/pixatar`) bakes the pinned wardrobe and bundles
upstream's renderer, so `npm test --workspace @pixel-index/pixatar` runs against
the new pin too:

- **`test/fixtures/legacy-seeds.json` must never change.** It pins what existing
  seed codes decode to, and people store those codes. If a bump breaks it,
  upstream removed or renamed a part that a code names. Fix that on the index side,
  or take it upstream (step 4).
- **The pinned text seeds and snapshots** (`test/pinned.test.ts`,
  `test/__snapshots__/`) can change on purpose when the bump adds parts or redraws
  art. Update them deliberately (`npx vitest run -u` in `packages/pixatar` for the
  snapshots, by hand for `pinned.test.ts`, and the same values in
  `python/tests/test_pixatar.py`, which CI's Python job checks). Say in the PR body
  that free-text seeds now deal differently. The web's `seeds.test.ts` and
  `CharacterDesignerPage.test.tsx` pin `octocat`'s code as well.
- The tests check that the compact seed tables still cover every slot and colour
  key upstream has. When they don't, the failure says what to append.

Never run a repo-wide formatter that isn't the repo's own: a stray `npx prettier`
without the repo config rewrote all of `render.ts` once.

### 4. Only if an upstream change is genuinely needed

`nntin-bot` can't push to `pixel-agents-hq/pixel-agents`. Use the fork
`nntin-bot/pixel-agents` (its own repo, full access):

```bash
git -C vendor/pixel-agents remote add fork https://github.com/nntin-bot/pixel-agents.git
git -C vendor/pixel-agents checkout -b fix/<topic> origin/main
# commit, then
git -C vendor/pixel-agents push -u fork fix/<topic>
```

Open **two** PRs from that branch:

1. **Upstream:** `gh pr create --repo pixel-agents-hq/pixel-agents --head nntin-bot:fix/<topic> --draft`.
   Fill in `.github/pull_request_template.md`.
2. **CI mirror inside the fork:** base `main` of `nntin-bot/pixel-agents`.
   Upstream's pipeline doesn't run for us on a cross-fork PR, so this is
   where it runs. First sync the fork's `main` to upstream so the mirror
   shows only your commits. Mark the PR "CI mirror of #N, don't merge".

Upstream rules the fork pipeline enforces: the PR title subject must
start with a lowercase letter (`pr-title.yml`), and the title must be a
conventional commit.

The index can pin the fork commit meanwhile. GitHub serves it from
`pixel-agents-hq/pixel-agents` by SHA through `refs/pull/N/head`. Check with
`git init -q t && git -C t fetch --depth=1 https://github.com/pixel-agents-hq/pixel-agents.git <sha>`.
Keep the index PR a draft until upstream merges, then re-pin to the merged
commit.

### 5. Watch CI in both repos until it settles

- **Index:** `gh pr checks <N> --repo pixel-agents-hq/index --watch`. Lint,
  Web Docker image builds and Vercel catch what local runs miss (deprecated-API
  lint, missing container dependencies).
- **pixel-agents:** the fork's mirror PR. List runs with
  `gh api "repos/nntin-bot/pixel-agents/actions/runs?per_page=10"`. If there
  are none at all, the fork's Actions were never enabled. An owner has to
  click "enable workflows" in the fork's Actions tab, and the API can't do it.
  Then close and reopen the PR to trigger it.
- Secret-gated jobs skip on the fork instead of failing: Vercel deploy via
  `deploy-preview-precheck` (`reason=missing-secrets`), and `update-badges` /
  `publish-extension` via a repository check. A failure there is a gating bug.
- A force-push cancels the in-flight run (`cancel-in-progress`), and
  "Required Checks" then fails from the cancelled shards. Judge only the run
  on the current head SHA.
- Use `gh run watch` / `--watch` in the background rather than polling.

### 6. Close what you supersede

- The automated `vendor-update.yml` PR for the same range: comment with what
  yours adds, then close it. The next scheduled run reopens one only if
  upstream `main` has moved past your pin by the time yours merges.
- Upstream / fork PRs that turned out to be unnecessary: close both the
  upstream PR and its fork mirror. On the upstream one, leave a short
  apology to the maintainers and say why it's no longer needed. Delete the
  fork branch if nothing pins it.
- Put `Supersedes #N` in the surviving PR's body so the trail is linked.

`gh pr edit` needs `read:org`, which the bot token lacks. Edit titles and
bodies with `gh api -X PATCH repos/<owner>/<repo>/pulls/<N> -f title=... -F body=@file`.

### 7. PR body for the index PR

Name each upstream change that broke something and the fix for each. List
what you checked and found unbroken. Include a table of the harness steps
actually run against the final pin (not just code-read), with results. State
any merge-order dependency.
