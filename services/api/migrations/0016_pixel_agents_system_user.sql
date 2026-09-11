-- The synthetic author for synced built-in Pixel Agents assets
-- (assets/builtinSync.ts, custom_assets.source = 'builtin').
--
-- Kept distinct from the seed-layout system user (0002_system_user.sql,
-- '...0001', username 'pixel-index'): GET /api/v1/assets is a public API,
-- and toSummary()/toDetail() always populate author.username regardless of
-- what the web UI chooses to render — reusing the seed-layout owner would
-- make every built-in asset's API response claim "authored by pixel-index",
-- which is the wrong provenance. This row is what "authored by pixel-agents"
-- means instead.
--
-- discord_id is NULL, which the users_system_cannot_login check constraint
-- requires of system users — nothing can ever authenticate as this account.

INSERT INTO users (id, discord_id, username, role, is_system)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  NULL,
  'pixel-agents',
  'user',
  true
)
ON CONFLICT (id) DO NOTHING;
