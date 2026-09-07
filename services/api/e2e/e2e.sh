#!/usr/bin/env bash
# Builds the real API + renderer images, brings up a real Postgres alongside
# them (see docker-compose.yml), and runs run.ts against the live stack over
# real HTTP — the same check done by hand for #6/#7/#8/#9/#10 before this
# script existed, now repeatable in CI. Always tears the stack down, pass or
# fail.
set -euo pipefail
cd "$(dirname "$0")"

export SESSION_SECRET
SESSION_SECRET=$(openssl rand -base64 48)
export WEBHOOK_SECRET_ENCRYPTION_KEY
WEBHOOK_SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32)

cleanup() {
  docker compose down --volumes --remove-orphans
}
trap cleanup EXIT

docker compose up --build --wait

# Not `npx tsx`: npx's own module resolution mis-resolves this package's
# relative entry path (observed misresolving run.ts against the parent
# workspace root instead of this directory). The repo-root binary — where
# tsx is hoisted by npm workspaces — has no such problem.
DATABASE_URL="postgres://pixel:pixel@localhost:15432/pixel_index" \
API_URL="http://localhost:18080" \
SESSION_SECRET="$SESSION_SECRET" \
  ../../../node_modules/.bin/tsx run.ts
