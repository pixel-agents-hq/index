# The API: config, CORS, health, rate limits, Discord auth (#7) and the
# public layout API (#6). No browser here — that is the renderer's job
# (services/renderer).
#
# Build context is the REPO ROOT, not this directory:
#   docker build -f services/api/Dockerfile .

FROM node:22-alpine AS builder

WORKDIR /app

# Workspace manifests first: they change far less often than source.
COPY package.json package-lock.json ./
# Every workspace's tsconfig extends this, so `tsc` cannot run without it.
# Beside the manifests rather than with the source below: it changes about as
# often as they do, and the layer caching should reflect that.
COPY tsconfig.strict.json ./
COPY packages/layout-core/package.json ./packages/layout-core/
COPY packages/pixatar/package.json ./packages/pixatar/
COPY services/api/package.json ./services/api/
RUN npm ci --workspace @pixel-index/layout-core --workspace @pixel-index/pixatar --workspace @pixel-index/api --include-workspace-root

COPY packages/layout-core ./packages/layout-core

# GET /api/v1/avatars/:seed.png (#133) draws with the avatar package. Building
# it bakes the pinned wardrobe (webview-ui/src/characters/art) and bundles the
# upstream renderer and profile sources it imports into its dist, so these
# vendor sources are needed here in the builder only: the runtime stage below
# copies packages/pixatar/dist and no vendor TypeScript. The pin comes from
# vendor/pixel-agents.commit, not git: there is no git in this image, and the
# version from vendor/pixel-agents/package.json.
COPY vendor/pixel-agents.commit ./vendor/pixel-agents.commit
COPY vendor/pixel-agents/package.json ./vendor/pixel-agents/package.json
COPY vendor/pixel-agents/core/src ./vendor/pixel-agents/core/src
COPY vendor/pixel-agents/webview-ui/src ./vendor/pixel-agents/webview-ui/src
COPY packages/pixatar ./packages/pixatar

COPY services/api ./services/api
RUN npm run build --workspace @pixel-index/layout-core \
 && npm run build --workspace @pixel-index/pixatar \
 && npm run build --workspace @pixel-index/api

# Drop devDependencies (drizzle-kit, tsx, typescript, vitest, PGlite …) —
# drizzle-kit never runs in production, and prod's own tree audits clean even
# though drizzle-kit's dev-only esbuild chain does not. See services/api/README.md.
RUN npm prune --omit=dev --workspace @pixel-index/layout-core --workspace @pixel-index/pixatar --workspace @pixel-index/api

# ── Runtime ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S pixelindex && adduser -S pixelindex -G pixelindex

COPY --from=builder --chown=pixelindex:pixelindex /app/node_modules ./node_modules
COPY --from=builder --chown=pixelindex:pixelindex /app/package.json ./package.json
COPY --from=builder --chown=pixelindex:pixelindex /app/packages/layout-core ./packages/layout-core
# Only the built package: its dist bundles the wardrobe and renderer, so it
# reads nothing of vendor/pixel-agents at runtime (fflate, its one dependency,
# is in node_modules above).
COPY --from=builder --chown=pixelindex:pixelindex /app/packages/pixatar/package.json ./packages/pixatar/package.json
COPY --from=builder --chown=pixelindex:pixelindex /app/packages/pixatar/dist ./packages/pixatar/dist
COPY --from=builder --chown=pixelindex:pixelindex /app/services/api/dist ./services/api/dist
COPY --from=builder --chown=pixelindex:pixelindex /app/services/api/package.json ./services/api/package.json
COPY --from=builder --chown=pixelindex:pixelindex /app/services/api/migrations ./services/api/migrations
COPY --chown=pixelindex:pixelindex services/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The git-versioned seed (#18) — loaded into the database on first boot
# (docker-entrypoint.sh, after migrations) so a fresh install is never an
# empty page. seed.ts resolves its path relative to this copy, four levels
# up from services/api/dist/db/ — see SEED_DIR there.
COPY --chown=pixelindex:pixelindex seed ./seed

# GET /api/v1/meta (#6) reads the pinned upstream's version, bundled
# layoutRevision and (once #8 exists) furniture catalog via
# @pixel-index/layout-core. Only package.json and the asset JSON are needed —
# no node_modules, no webview source, unlike the renderer, which actually
# boots this checkout's dev server. That keeps this image a fraction of the
# renderer's size for the one piece of upstream metadata it actually reads.
COPY --chown=pixelindex:pixelindex vendor/pixel-agents/package.json ./vendor/pixel-agents/package.json
COPY --chown=pixelindex:pixelindex vendor/pixel-agents/webview-ui/public/assets ./vendor/pixel-agents/webview-ui/public/assets

# Which upstream this is. The copied tree above has no usable git — the
# submodule's .git is a pointer to a gitdir outside the build context — so the
# pin travels as this file instead, kept equal to the gitlink by
# `npm run vendor:commit` and enforced in CI. It used to be a build argument the
# operator had to remember; nobody did, and every image reported commit: null.
COPY --chown=pixelindex:pixelindex vendor/pixel-agents.commit ./vendor/pixel-agents.commit

# Which pixel-index this is, for GET / and GET /api/v1/meta (#32) — a
# different problem from the pinned vendor/pixel-agents.commit above. That
# one exists because the submodule's .git is unreachable from inside the
# build context; THIS repo's own .git is ordinarily right there wherever
# `docker build`/`docker compose build` runs, so a plain build ARG is enough
# — no committed stamp file needed. Unset (empty string) reports commit: null
# rather than failing the build; this is informational, not load-bearing.
#   docker build -f services/api/Dockerfile --build-arg API_COMMIT=$(git rev-parse HEAD) .
ARG API_COMMIT
ENV API_COMMIT=${API_COMMIT}

ENV PIXEL_AGENTS_DIR=/app/vendor/pixel-agents \
    API_HOST=:: \
    API_PORT=3000

USER pixelindex

EXPOSE 3000

# Readiness, not liveness: this asserts Postgres is actually reachable, so a
# database outage takes the API out of the load balancer rather than serving
# 503s from every route behind a "healthy" container. 127.0.0.1 rather than
# localhost, because localhost resolves to ::1 first and a single-stack
# listener would fail a check it should pass — the exact trap that took the
# v1 static site offline with a bare 404 and nothing in any log.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "services/api/dist/index.js"]
