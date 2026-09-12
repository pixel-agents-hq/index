#!/bin/sh
# Apply pending migrations, backfill any data a schema change alone can't fix,
# seed if the database is empty, sync the built-in asset catalog against the
# pinned commit, then hand off to the real command (node
# services/api/dist/index.js). This is what makes a self-hoster's first
# `docker compose up` provision a working, populated database with no manual
# step (see migrate.ts, backfill-seats.ts, backfill-asset-tags.ts, seed.ts,
# sync-builtin-assets.ts) —
# this entrypoint runs before every boot, not a one-off job compose has to
# remember to run.
#
# All steps are idempotent, so running them before every start (not just the
# first) is intended, not wasteful: a restart after a deploy that bumped the
# schema just works, and seeding is a silent no-op once any layout exists —
# seeded or not.
set -eu

echo "Applying database migrations…"
node services/api/dist/db/migrate.js

echo "Backfilling seat_count on any rows written before it existed…"
node services/api/dist/db/backfill-seats.js

echo "Backfilling visible_cols/visible_rows on any rows written before they existed…"
node services/api/dist/db/backfill-visible-bounds.js

echo "Backfilling custom_assets.tags on any rows written before it existed…"
node services/api/dist/db/backfill-asset-tags.js

echo "Seeding starter layouts if the database is empty…"
node services/api/dist/db/seed.js

echo "Syncing built-in Pixel Agents assets against the pinned commit…"
node services/api/dist/db/sync-builtin-assets.js

exec "$@"
