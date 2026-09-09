# Pixel Index

A community index of [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents)
office layouts — browse, download, import.

[![CI](https://github.com/pixel-agents-hq/pixel-index/actions/workflows/ci.yml/badge.svg)](https://github.com/pixel-agents-hq/pixel-index/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/pixel-agents-hq/pixel-index)](LICENSE)
[![Stars](https://img.shields.io/github/stars/pixel-agents-hq/pixel-index?style=flat)](https://github.com/pixel-agents-hq/pixel-index/stargazers)

🖼️ [Live gallery](https://pixel-index.nntin.xyz) •
🎮 [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) •
👾 [Discord](https://discord.gg/vkse9z5My) •
🛠️ [Developer API](https://pixel-index.nntin.xyz/developer) •
🤝 [Contributing](docs/CONTRIBUTING.md)

![Pixel Index gallery screenshot](docs/screenshot.png)

Pixel Index is a public, community-run gallery of office layouts for
[Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) — the pixel-art
character office that turns your AI coding agents into animated characters at desks.
Design an office in Pixel Agents, publish it here, and anyone can browse, preview, and
import it back into their own Pixel Agents install.

## Using it

1. Open the [live gallery](https://pixel-index.nntin.xyz) and browse or search by size,
   furniture, pets, or seats.
2. Found one you like? **Download** the `layout.json` and load it in Pixel Agents with
   **Layout → Import**.
3. Want to share your own? **Log in with Discord**, paste or upload your `layout.json`,
   **check the preview**, then **publish** — it's public immediately, no review queue.

Once published, it's yours: **My layouts** lets you edit, replace, or delete it at any
time.

## Content policy and moderation

This index is post-moderated — content is public on submission, not reviewed before it
appears. See [CONTENT_POLICY.md](docs/CONTENT_POLICY.md) for what is not allowed and how
to report a layout, and [MODERATORS.md](docs/MODERATORS.md) for how the moderation team
applies it.

## Self-hosting

An npm workspace: `packages/layout-core` (validation, shared by everything below),
`apps/web` (the gallery SPA), `services/api` (Fastify + Postgres, the public API and
auth), and `services/renderer` (Playwright + the pinned upstream, draws every preview).

```bash
git submodule update --init --recursive
cp .env.example .env    # fill in the REQUIRED values — see the file itself
API_COMMIT=$(git rev-parse HEAD) docker compose up --build
```

Brings up a complete, self-hostable index — Postgres, the API, the renderer, and the
built frontend, all talking to each other over the compose network — no external
network, reverse proxy, or pre-existing infrastructure required. `API_COMMIT` is
optional but recommended: without it, `GET /` and `GET /api/v1/meta` report
`commit: null` instead of the commit you actually built from — see
[`docs/deployment.md`](docs/deployment.md#api_commit--pixel-indexs-own-commit-a-build-argument-instead)
for why it has to be passed at build time.

Putting a real domain and TLS in front of it is a deliberately separate step — see
[`docs/deployment.md`](docs/deployment.md) for Traefik, Caddy, and plain nginx.

## Architecture

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) covers the four-service stack — what each
piece is, how they talk to each other, why the frontend and API are two separate origins
with a bearer-token session instead of a cookie, and why every preview is drawn by a
real browser rather than reimplemented.

Building a tool that generates custom-asset upload zips (furniture, characters, pets)?
[`docs/custom-asset-zip-contract.md`](docs/custom-asset-zip-contract.md) is the
versioned, pinnable contract for that format.

## Development

```bash
git submodule update --init --recursive
npm ci
(cd vendor/pixel-agents && npm ci)
npx playwright install chromium   # needed by renderer tests and the web live-preview E2E

npm run validate      # seed/ against the pinned Pixel Agents
npm test              # every workspace's unit tests
npm run typecheck      # every workspace
```

Each workspace also has its own `npm run dev` (`apps/web`, `services/api`,
`services/renderer`) for iterating on just that piece against the others already
running. See [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) for the full workflow —
commit conventions, linting, and how to propose a seed layout.

## License

This repository — the tooling, the schemas and the site — is MIT licensed; see
[LICENSE](LICENSE). Layouts are not licensed individually; each is credited to
its author in `meta.json`. The seed layouts are by
[pablodelucca](https://github.com/pablodelucca), who also wrote Pixel Agents.
