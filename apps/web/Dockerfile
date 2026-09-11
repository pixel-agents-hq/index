# Build the SPA, then serve the static output. For self-hosting only (#17) —
# the official index deploys this same workspace to GitHub Pages instead
# (.github/workflows/pages.yml); this image exists so `docker compose up`
# alone is a complete, working self-hosted index with no external CDN.
#
# Build context is the REPO ROOT, not this directory:
#   docker build -f apps/web/Dockerfile --build-arg VITE_API_BASE_URL=https://api.example.com .

FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
# Every workspace's tsconfig extends this, so `tsc` cannot run without it.
# Beside the manifests rather than with the source below: it changes about as
# often as they do, and the layer caching should reflect that.
COPY tsconfig.strict.json ./
COPY packages/layout-core/package.json ./packages/layout-core/
COPY apps/web/package.json ./apps/web/
RUN npm ci --workspace @pixel-index/layout-core --workspace @pixel-index/web --include-workspace-root

# The web build's own build/liveOfficeAssets.ts imports @pixel-index/layout-core
# (furnitureCategories()) — like every other workspace that depends on it, this
# has to be built first, since `import` resolves package.json's "main"
# (dist/index.js), not source.
COPY packages/layout-core ./packages/layout-core
RUN npm run build --workspace @pixel-index/layout-core

COPY apps/web ./apps/web

# The live layout-detail preview compiles a small browser-only wrapper around
# the pinned upstream renderer. Copy only what that build consumes; in
# particular, do not copy vendor/node_modules from a developer's checkout.
COPY vendor/pixel-agents.commit ./vendor/pixel-agents.commit
COPY vendor/pixel-agents/package.json ./vendor/pixel-agents/package.json
COPY vendor/pixel-agents/core ./vendor/pixel-agents/core
COPY vendor/pixel-agents/webview-ui/src ./vendor/pixel-agents/webview-ui/src
COPY vendor/pixel-agents/webview-ui/public ./vendor/pixel-agents/webview-ui/public

# Baked in at build time, like every other build-time-only config value in
# this app (vite.config.ts) — there is no server here to inject it at
# request time the way a real backend could. A self-hoster rebuilds this
# image if their API's origin ever changes. VITE_BASE_PATH is deliberately
# NOT set here: this image serves from the domain root, unlike the GitHub
# Pages project-site deploy.
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build --workspace @pixel-index/web

FROM nginx:alpine AS runtime

COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# 127.0.0.1, not localhost: localhost resolves to ::1 first inside a
# container, and a single-stack listener would fail a check it should pass.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz > /dev/null || exit 1
