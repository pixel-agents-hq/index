/**
 * End-to-end verification against real containers — Postgres, the renderer
 * microservice, and the API itself, the actual built Docker images, not test
 * doubles or a stubbed renderer (unlike src/**\/*.test.ts, which is
 * deliberately fast and hermetic). Run via `e2e.sh`, which builds the images,
 * brings the stack up with docker compose, and execs this script.
 *
 * Deliberately not vitest: nothing here is an independent unit, there is no
 * per-test isolation (everything shares one running stack, one database),
 * and a plain top-to-bottom script reads as the story of one full
 * owner-then-admin session, which is what actually needs proving here —
 * unit coverage of the same guards already lives in manage.test.ts and
 * users/routes.test.ts.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Client } from 'pg';

import { signAccessToken } from '../src/auth/tokens.js';
import type { SubmitLayoutBody } from '../src/layouts/responses.js';
import type { MetaBody } from '../src/meta.js';
import type { ListAdminUsersBody } from '../src/users/routes.js';

const API_URL = process.env.API_URL ?? 'http://localhost:18080';
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!DATABASE_URL || !SESSION_SECRET) {
  throw new Error('DATABASE_URL and SESSION_SECRET are required — see e2e.sh');
}
// The narrowing above does not reach into the closures below, so bind the
// checked value once rather than re-asserting it at each use.
const sessionSecret: string = SESSION_SECRET;

const db = new Client({ connectionString: DATABASE_URL });

let userCounter = 0;
async function createUser(
  role: 'user' | 'moderator' | 'admin' = 'user',
  fixedDiscordId?: string,
) {
  userCounter += 1;
  const discordId = fixedDiscordId ?? `e2e-${Date.now()}-${userCounter}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (discord_id, username, role) VALUES ($1, $1, $2) RETURNING id`,
    [discordId, role],
  );
  const created = rows[0];
  assert(created, 'INSERT ... RETURNING id returned no row');
  const accessToken = await signAccessToken({ sub: created.id, role }, sessionSecret, 15 * 60_000);
  return { id: created.id, accessToken };
}

/** Directly seeds a `deleted` layout — standing in for "a layout that existed and was withdrawn", without needing a submit+delete round trip for content the test never wants live. */
async function seedDeletedLayout(authorUserId: string, raw: string) {
  const sha256 = createHash('sha256').update(raw).digest('hex');
  await db.query(
    `INSERT INTO layouts (slug, title, author_user_id, raw, layout, sha256, cols, rows,
       furniture_count, area_count, pet_count, carpet_count, layout_revision,
       pixel_agents_version, visibility)
     VALUES ($1, 'E2E seed', $2, $3::text, $3::jsonb, $4, 1, 1, 0, 0, 0, 0, 1, '0.0.0', 'deleted')`,
    [`e2e-seed-${Date.now()}-${userCounter}`, authorUserId, raw, sha256],
  );
}

/**
 * `headers` is narrowed to a plain record rather than fetch's own `HeadersInit`.
 * That union also admits `string[][]` and `Headers`, and spreading either of
 * those into an object literal produces array indices or nothing at all — so
 * the header would be silently dropped instead of sent. Every call here passes
 * a record; the type now says so.
 */
function api(
  path: string,
  init: Omit<RequestInit, 'headers'> & { token?: string; headers?: Record<string, string> } = {},
) {
  const { token, headers, ...rest } = init;
  return fetch(`${API_URL}${path}`, {
    ...rest,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
}

/**
 * A response body, as the shape the caller expects.
 *
 * The `as` is unavoidable — this reads real JSON over real HTTP — but the type
 * argument is the API's own exported response interface, so a field this script
 * asserts on has to exist in the service that produced it.
 */
async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function layoutJson(cols: number, rows: number) {
  return JSON.stringify({
    version: 1,
    layoutRevision: 1,
    cols,
    rows,
    tiles: Array(cols * rows).fill(0),
    furniture: [],
  });
}

let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ok  - ${name}`);
}

async function waitUntilReady() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const res = await api('/ready').catch(() => null);
    if (res?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('/ready never returned 200');
}

async function main() {
  await db.connect();
  await waitUntilReady();

  await step('a real pinned upstream is reported at /api/v1/meta', async () => {
    const meta = await json<MetaBody>(await api('/api/v1/meta'));
    // `version` is nullable in the pin, so say so before matching: assert.match
    // on null throws a TypeError about argument types instead of reporting the
    // thing that actually went wrong.
    assert.ok(meta.pixelAgents.version, 'the image reported no upstream version');
    assert.match(meta.pixelAgents.version, /^\d+\.\d+\.\d+/);

    // The commit, from inside a real container — the one thing no unit test
    // can prove. A copied vendor/ tree has no usable git (its .git is a
    // pointer to a gitdir that was never copied), so this can only be
    // answered by the stamp the Dockerfile copies beside it. It was a
    // build argument once, nobody passed it, and every deployed image
    // reported null; this is what makes that regression loud instead of
    // something you notice months later in a preview that will not update.
    assert.match(
      meta.pixelAgents.commit ?? '',
      /^[0-9a-f]{40}$/,
      'the image reported no upstream commit — is vendor/pixel-agents.commit copied in?',
    );
    assert.equal(
      meta.pixelAgents.commit,
      readFileSync(new URL('../../../vendor/pixel-agents.commit', import.meta.url), 'utf-8').trim(),
      'the image reports a different upstream than this checkout pins',
    );
  });

  const owner = await createUser('user');
  const admin = await createUser('user', '999999999999999999');
  // Admin inherits every Moderator capability.
  const moderator = admin;
  const stranger = await createUser('user');

  let slug = '';

  await step('owner submits a layout and the renderer produces a real preview', async () => {
    const res = await api('/api/v1/layouts?title=E2E+Office', {
      method: 'POST',
      token: owner.accessToken,
      headers: { 'content-type': 'application/json' },
      body: layoutJson(4, 4),
    });
    assert.equal(res.status, 201);
    const body = await json<SubmitLayoutBody>(res);
    assert.equal(body.previewReady, true);
    slug = body.slug;

    const preview = await api(`/api/v1/layouts/${slug}/preview.png`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
  });

  await step('a stranger cannot edit it', async () => {
    const res = await api(`/api/v1/layouts/${slug}`, {
      method: 'PATCH',
      token: stranger.accessToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Hijacked' }),
    });
    assert.equal(res.status, 403);
  });

  await step('the owner edits their own title with no reason required', async () => {
    const res = await api(`/api/v1/layouts/${slug}`, {
      method: 'PATCH',
      token: owner.accessToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'E2E Office Renamed' }),
    });
    assert.equal(res.status, 200);
  });

  await step('the owner hides their own layout, no reason required, and it vanishes from the public API (#72)', async () => {
    const res = await api(`/api/v1/layouts/${slug}`, {
      method: 'PATCH',
      token: owner.accessToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'hidden' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await api(`/api/v1/layouts/${slug}`)).status, 404);
  });

  await step('the owner un-hides their own layout back to public, no reason required (#72)', async () => {
    const res = await api(`/api/v1/layouts/${slug}`, {
      method: 'PATCH',
      token: owner.accessToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await api(`/api/v1/layouts/${slug}`)).status, 200);
  });

  await step('"removed" is rejected as an unknown visibility value — that state no longer exists (#72)', async () => {
    const res = await api(`/api/v1/layouts/${slug}`, {
      method: 'PATCH',
      token: owner.accessToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'removed', reason: 'nope' }),
    });
    assert.equal(res.status, 400);
  });

  await step('a moderator hiding without a reason is rejected', async () => {
    const res = await api(`/api/v1/layouts/${slug}`, {
      method: 'PATCH',
      token: moderator.accessToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'hidden' }),
    });
    assert.equal(res.status, 400);
  });

  await step('a moderator hides it with a reason, and it vanishes from the public API', async () => {
    const res = await api(`/api/v1/layouts/${slug}`, {
      method: 'PATCH',
      token: moderator.accessToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'hidden', reason: 'e2e moderation test' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await api(`/api/v1/layouts/${slug}`)).status, 404);
  });

  await step('a moderator restores it', async () => {
    const res = await api(`/api/v1/layouts/${slug}`, {
      method: 'PATCH',
      token: moderator.accessToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public', reason: 'appeal granted' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await api(`/api/v1/layouts/${slug}`)).status, 200);
  });

  await step('a moderator cannot replace the layout content, only the owner can', async () => {
    const modAttempt = await api(`/api/v1/layouts/${slug}/layout`, {
      method: 'PUT',
      token: moderator.accessToken,
      headers: { 'content-type': 'application/json' },
      body: layoutJson(5, 5),
    });
    assert.equal(modAttempt.status, 403);

    const raw = layoutJson(6, 6);
    const ownerAttempt = await api(`/api/v1/layouts/${slug}/layout`, {
      method: 'PUT',
      token: owner.accessToken,
      headers: { 'content-type': 'application/json' },
      body: raw,
    });
    assert.equal(ownerAttempt.status, 200);
    assert.equal(await (await api(`/api/v1/layouts/${slug}/download`)).text(), raw);
  });

  await step('the owner deletes it, and re-deleting is a no-op', async () => {
    const first = await api(`/api/v1/layouts/${slug}`, { method: 'DELETE', token: owner.accessToken });
    assert.equal(first.status, 204);
    const second = await api(`/api/v1/layouts/${slug}`, { method: 'DELETE', token: owner.accessToken });
    assert.equal(second.status, 204);
    assert.equal((await api(`/api/v1/layouts/${slug}`)).status, 404);
  });

  // #72: DELETE is no longer owner-only — a moderator reaches the same
  // permanent outcome an owner always has, on anyone's layout, with a
  // reason. There used to be a separate moderator-only "removed" visibility
  // for this; it is gone.
  const modDeleteRaw = layoutJson(7, 7);
  let modDeleteSlug = '';
  await step('owner submits a second layout, for moderator-deletion coverage (#72)', async () => {
    const res = await api('/api/v1/layouts?title=E2E+Moderator+Delete+Target', {
      method: 'POST',
      token: owner.accessToken,
      headers: { 'content-type': 'application/json' },
      body: modDeleteRaw,
    });
    assert.equal(res.status, 201);
    const body = await json<SubmitLayoutBody>(res);
    modDeleteSlug = body.slug;
  });

  await step("a moderator deleting someone else's layout without a reason is rejected (#72)", async () => {
    const res = await api(`/api/v1/layouts/${modDeleteSlug}`, {
      method: 'DELETE',
      token: moderator.accessToken,
    });
    assert.equal(res.status, 400);
    assert.equal((await api(`/api/v1/layouts/${modDeleteSlug}`)).status, 200);
  });

  await step("a moderator deletes someone else's layout with a reason, and it is permanent (#72)", async () => {
    const res = await api(`/api/v1/layouts/${modDeleteSlug}`, {
      method: 'DELETE',
      token: moderator.accessToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'e2e moderator delete' }),
    });
    assert.equal(res.status, 204);
    assert.equal((await api(`/api/v1/layouts/${modDeleteSlug}`)).status, 404);
  });

  await step('the owner cannot revive a moderator-deleted layout via PATCH — deletion is permanent (#72)', async () => {
    const res = await api(`/api/v1/layouts/${modDeleteSlug}`, {
      method: 'PATCH',
      token: owner.accessToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    });
    assert.equal(res.status, 403);
  });

  await step('the SAME owner can still resubmit the exact bytes a MODERATOR deleted (#72 deliberate policy)', async () => {
    const res = await api('/api/v1/layouts?title=Resubmit+After+Moderator+Delete', {
      method: 'POST',
      token: owner.accessToken,
      headers: { 'content-type': 'application/json' },
      body: modDeleteRaw,
    });
    assert.equal(res.status, 201);
  });

  await step(
    "a stranger cannot launder content by resubmitting someone else's deleted layout, but the same owner can",
    async () => {
      const raw = layoutJson(9, 9);
      await seedDeletedLayout(owner.id, raw);

      const strangerAttempt = await api('/api/v1/layouts?title=Laundering+Attempt', {
        method: 'POST',
        token: stranger.accessToken,
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      assert.equal(strangerAttempt.status, 409);

      const ownerAttempt = await api('/api/v1/layouts?title=Owner+Republish', {
        method: 'POST',
        token: owner.accessToken,
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      assert.equal(ownerAttempt.status, 201);
    },
  );

  // Character profiles: the one path that needs the API and the renderer
  // together for real — the renderer composes the config with the pinned
  // upstream's own wardrobe code, which no unit test (they stub it) can prove.
  await step('a character profile config is composed by the real renderer and published as a character', async () => {
    const config = { name: 'E2E Owl', body: 'flat', eyeShape: 'plain', hair: 'mop', full: 'business_suit', v: 35 };
    const res = await api('/api/v1/assets?fileName=owl.json', {
      method: 'POST',
      token: owner.accessToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    });
    assert.equal(res.status, 201);
    const asset = await json<{ assetId: string; assetKind: string; tags: string[] }>(res);
    assert.equal(asset.assetKind, 'character');
    assert.deepEqual(asset.tags, ['animated', 'profile']);

    const frames = await json<{ poses: { key: string; frames: string[] }[] }>(
      await api(`/api/v1/assets/${asset.assetId}/frames`),
    );
    assert.ok(frames.poses.some((pose) => pose.key === 'seated-down'), 'no seated pose: the sheet was not 8 frames a row');

    const back = await json<Record<string, unknown>>(await api(`/api/v1/assets/${asset.assetId}/profile.json`));
    assert.equal(back.name, 'E2E Owl');
    assert.equal(back.body, 'flat');
  });

  await step('a config upstream would refuse is refused with upstream’s reason', async () => {
    const res = await api('/api/v1/assets', {
      method: 'POST',
      token: owner.accessToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nobody', body: 'no-such-body' }),
    });
    assert.equal(res.status, 422);
  });

  await step('the built-in characters are the pinned upstream’s default profiles', async () => {
    const list = await json<{ total: number; assets: { assetId: string }[] }>(
      await api('/api/v1/assets?source=builtin&profile=true&limit=100'),
    );
    assert.equal(list.total, 6);
    assert.deepEqual(list.assets.map((a) => a.assetId).sort(), ['CHAR_0', 'CHAR_1', 'CHAR_2', 'CHAR_3', 'CHAR_4', 'CHAR_5']);
  });

  await step('a soundtrack is published by its song code and listed for its author', async () => {
    const res = await api('/api/v1/soundtracks', {
      method: 'POST',
      token: owner.accessToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'town-5-8f3a21c0', title: 'E2E standup' }),
    });
    assert.equal(res.status, 201);
    const created = await json<{ id: string; code: string }>(res);
    assert.equal(created.code, 'TOWN-5-8F3A21C0');
    const one = await json<{ title: string }>(await api(`/api/v1/soundtracks/${created.id}`));
    assert.equal(one.title, 'E2E standup');
  });

  await step('the admin directory is read-only and contains only interacted users', async () => {
    const plainAttempt = await api('/api/v1/admin/users', { token: stranger.accessToken });
    assert.equal(plainAttempt.status, 403);

    const directory = await api('/api/v1/admin/users?q=e2e-', { token: admin.accessToken });
    assert.equal(directory.status, 200);
    const body = await json<ListAdminUsersBody>(directory);
    assert.ok(body.users.length >= 2);
    assert.ok(body.users.every((user) => !('discordId' in user)));
    assert.ok(body.users.every((user) => 'layoutCount' in user));
  });

  await step('stale local role and block endpoints no longer exist', async () => {
    const role = await api(`/api/v1/users/${stranger.id}/role`, {
      method: 'PATCH',
      token: admin.accessToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'moderator' }),
    });
    const block = await api(`/api/v1/users/${stranger.id}/block`, {
      method: 'PATCH',
      token: admin.accessToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blocked: true, reason: 'obsolete' }),
    });
    assert.equal(role.status, 404);
    assert.equal(block.status, 404);
  });
}

try {
  await main();
  console.log(`\n${passed} e2e steps passed.`);
} finally {
  await db.end();
}
