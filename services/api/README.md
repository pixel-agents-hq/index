# @pixel-index/api

Fastify 5 over Postgres. Holds everything the static frontend cannot: the Discord client
secret, the database connection, and every authorization decision. The database layer,
service skeleton, Discord auth, public layout API, submission, owner self-service, and
moderation all exist — publishing, editing and moderating a layout no longer requires a
pull request.

## The HTTP surface today

```text
src/config.ts          env-only config, validated at boot, all problems reported at once
src/errors.ts           ApiError + the one error envelope every response uses
src/rateLimit.ts        writeRateLimitConfig() — the tighter per-route bucket
src/server.ts            Fastify app: CORS, rate limits, error handling, docs, /health, /ready
src/index.ts             entrypoint: open the pool, boot the server, shut down together
src/meta.ts              GET /api/v1/meta

src/auth/context.ts     request.user — wired up, verifies the bearer access token
src/auth/tokens.ts       sign/verify the access JWT; generate/hash opaque tokens
src/auth/discord.ts      Discord OAuth/profile/current guild-member HTTP API
src/auth/discordGrant.ts encrypted user OAuth grant persistence and refresh
src/auth/capability.ts   cached Discord membership + Basic/Moderator/Admin resolution
src/auth/sessions.ts     issue/rotate/revoke refresh tokens; login codes
src/auth/users.ts        profile upsert on login
src/auth/routes.ts       /auth/discord/login, /callback, /auth/token, /refresh, /logout, /me

src/layouts/query.ts     SQL: filter, sort, keyset-paginate, tag/author lookups
src/layouts/cursor.ts    opaque keyset pagination cursors — encode/decode/validate
src/layouts/serialize.ts DB row -> public JSON shape, one place, for list and detail alike
src/layouts/schemas.ts   the JSON Schemas that validate requests AND generate the OpenAPI doc
src/layouts/routes.ts    GET /layouts, /layouts/:slug{,/download,/preview.png,/thumbnail.png}
src/layouts/share.ts     POST /layouts/share — authenticated snapshot + persistent fan-out
src/renderer/client.ts   thin client for the renderer service, used by preview routes

src/layouts/submit.ts    POST /layouts — the whole submission pipeline
src/layouts/slug.ts      random, collision-safe submission slug — not title-derived
src/layouts/metadata.ts  tag validation, length limits, shared by submit.ts and manage.ts
src/layouts/upstreamValidator.ts  the layout-core validator, built once, shared by submit.ts and manage.ts
src/layouts/manage.ts    PATCH/PUT/DELETE /layouts/:slug, GET /me/layouts — owner edits and
                         moderator actions share these routes
src/moderation/audit.ts  recordModerationAction() — the one insert path into the append-only audit log
src/moderation/routes.ts GET /moderation/layouts — the moderation console's browse endpoint

schema/share-event-v1.schema.json  external layout.shared event contract
src/webhooks/schema.ts             schema loader and checked TypeScript event shape
src/webhooks/routes.ts             moderator creation/rotation and Admin subscription health
src/webhooks/delivery.ts           persistent queue worker, signed HTTP delivery and retries

src/users/routes.ts      GET /admin/users — read-only interacted-user directory
src/authors/routes.ts    GET /authors/:id — public author identity/count
```

The webhook/event interface for third-party receivers is documented in
[`docs/webhooks.md`](../../docs/webhooks.md). The versioned JSON Schema, not the prose
example, is the source of truth for its payload.

```bash
npm run dev --workspace @pixel-index/api    # tsx watch
npm test --workspace @pixel-index/api        # 326 tests, no real Postgres or renderer needed
```

`GET /health` is liveness — always 200 once the process is up. `GET /ready` actually
queries Postgres (2s timeout) and is what the Dockerfile's `HEALTHCHECK` uses, so a
database outage takes the container out of the load balancer instead of leaving it
"healthy" while every real route would 500.

## Configuration

Every required variable is validated **at boot**, and every problem is reported
**together** — a misconfigured deployment fails once with a full list, not one
frustrating restart per missing value. No hostname, domain or deployment-specific string
is ever compiled in; see [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md#what-each-service-actually-needs).

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | — | `postgres://` or `postgresql://` |
| `RENDERER_URL` | yes | — | The renderer, proxied by `/layouts/:slug/{preview,thumbnail}.png` |
| `PUBLIC_WEB_ORIGIN` | yes | — | Comma-separated **exact origins** allowed to call the API with credentials |
| `PUBLIC_WEB_ORIGIN_PATTERNS` | | — | Opt-in, narrowly scoped wildcards for frontends whose hostname is minted per deploy (Vercel PR previews) — see below |
| `DISCORD_CLIENT_ID` | yes | — | From the Discord Developer Portal |
| `DISCORD_CLIENT_SECRET` | yes | — | Same |
| `PUBLIC_API_ORIGIN` | yes | — | This API's own externally-reachable origin. `${this}/callback` **must exactly match** the redirect URI registered in the Discord Developer Portal — Discord rejects a mismatch, and mismatches fail late and confusingly |
| `SESSION_SECRET` | yes | — | Signs access tokens. `openssl rand -base64 48`. ≥32 characters, checked at boot |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | yes | — | API-only base64 32-byte AES-256-GCM key for subscriber signing secrets |
| `DISCORD_ADMIN_IDS` | | — | Comma-separated Discord user IDs that receive Admin |
| `DISCORD_GUILD_ID` | | — | Enables official-guild membership gating and role checks; omit for a fully functional unguilded instance |
| `DISCORD_MODERATOR_ROLE_IDS` | with guild | — | Comma-separated guild role IDs that receive Moderator |
| `DISCORD_INVITE_URL` | with guild | — | HTTPS invite shown to authenticated outsiders |
| `DISCORD_OAUTH_TOKEN_ENCRYPTION_KEY` | with guild | — | API-only, base64 32-byte AES-256-GCM key for retained user grants |
| `DISCORD_MEMBERSHIP_CACHE_TTL_MS` | | `60000` | Maximum membership/capability observation age |
| `ACCESS_TOKEN_TTL_MS` | | `900000` (15 min) | Access JWT lifetime; JWTs carry a user ID, not a role |
| `REFRESH_TOKEN_TTL_MS` | | `2592000000` (30 days) | |
| `LOGIN_CODE_TTL_MS` | | `60000` | Window for the post-`/callback` handoff to the SPA |
| `API_HOST` | | `::` | Dual-stack — see the healthcheck note below |
| `API_PORT` | | `3000` | |
| `API_TRUST_PROXY` | | `true` | Trust `X-Forwarded-For`. Every deployment sits behind a reverse proxy; a self-hoster exposing the API directly must set this `false` |
| `API_BODY_LIMIT_BYTES` | | `5000000` | Refused at the socket, before parsing |
| `LOG_LEVEL` | | `info` | Pino level |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | | `300` / `60000` | General bucket |
| `RATE_LIMIT_WRITE_MAX` / `RATE_LIMIT_WRITE_WINDOW_MS` | | `20` / `60000` | Tighter bucket for submission, render-triggering paths, and the auth endpoints |
| `RATE_LIMIT_SHARE_MAX` / `RATE_LIMIT_SHARE_WINDOW_MS` | | `1` / `300000` | Authenticated per-user Share bucket |
| `PIXEL_AGENTS_DIR` | | auto-discovered | Where `vendor/pixel-agents` lives, for `GET /api/v1/meta` and submission validation |
| `MAX_LAYOUT_BYTES` | | `2000000` | Submission size cap, refused before `JSON.parse` even runs — matches the renderer's own default so a layout accepted here is never subsequently rejected there |
| `MAX_SUBMISSIONS_PER_USER_PER_DAY` | | `20` | Post-moderation means a flood is a real, cheap attack — a real 24h count, not a token bucket |
| `MAX_SHARES_PER_USER_PER_DAY` | | `5` | Persisted rolling-24-hour outbound fan-out cap per user |

`PUBLIC_WEB_ORIGIN` entries must be an **origin only** — `https://pixel-index.example`,
never `https://pixel-index.example/` or `.../some/path`. `new URL(x).origin !== x` is
rejected at boot rather than silently never matching a real browser `Origin` header
later.

## CORS is a product surface here, not a detail

The frontend is on GitHub Pages and this service is on another origin, so every browser
call is cross-origin. The allowlist comes from `PUBLIC_WEB_ORIGIN`, so the official index
and a self-hoster's Pages domain are both just values — never hardcoded. Only an
allowlisted origin gets `Access-Control-Allow-Credentials: true`; anything else gets no
CORS headers at all, which is what makes a real browser block the response from ever
reaching page JS. A request with **no** `Origin` header (curl, server-to-server) is not a
CORS request and is unaffected either way.

### The one case exact origins cannot cover: per-deploy preview hostnames

A Vercel PR preview is served from a hostname minted for that build
(`https://<project>-<build-hash>-<team>.vercel.app`), so there is nothing to put in
`PUBLIC_WEB_ORIGIN` and every credentialed call from a preview fails CORS.
`PUBLIC_WEB_ORIGIN_PATTERNS` is the opt-in escape hatch, and it is validated at boot to
stay narrow: **https only**, **exactly one `*` per pattern**, the `*` **never crosses a
dot** (so it substitutes for part of a single hostname label), and a **whole-label
wildcard is rejected** — `https://*.vercel.app` fails to boot, because it would grant
credentialed access to every project on a shared platform domain rather than yours.

`allowsWebOrigin()` in `config.ts` is the single answer to "may this origin call us with
credentials?", used by both the CORS check and the OAuth `returnTo` allowlist — if those
two disagreed, login from a preview would redirect back successfully and then fail on the
first API call. The residual risk and how to scope a pattern tightly are covered in
[`docs/deployment.md`](../../docs/deployment.md#public_web_origin_patterns-and-its-trade-off).

## One error envelope

Every error response — thrown deliberately, raised by Fastify's schema validation, or
unhandled — comes out the same shape:

```jsonc
{ "error": "validation_error", "message": "Validation failed.", "issues": [ /* … */ ] }
```

`issues` is only present on a 422, and is exactly
`@pixel-index/layout-core`'s `ValidationResult.issues` — `ApiError.validation(result.issues)`
is the whole translation layer needed. `ApiError` has `.notFound()`, `.forbidden()`,
`.unauthorized()`, `.conflict()` and `.badRequest()` statics; anything unexpected is
logged in full server-side and rendered to the client as a bare `internal_error`, never
leaking internals.

## Rate limiting

`@fastify/rate-limit`, registered once, globally, keyed on the real client via
`trustProxy` (not the reverse proxy's own IP). A 429 carries `Retry-After` and the shared
envelope. A route that needs the tighter bucket spreads in `writeRateLimitConfig(config)`:

```ts
app.post('/api/v1/layouts', writeRateLimitConfig(config), handler);
```

which overrides just that route — the general bucket for everything else is untouched.

> `@fastify/rate-limit`'s `errorResponseBuilder` does not `reply.send()` — it *returns a
> value that gets thrown* into Fastify's normal error pipeline, so a plain object with no
> `.statusCode` falls back to a 500. The builder in `server.ts` mirrors the plugin's own
> default shape (`new Error(...)` with `.statusCode` set) so the central error handler has
> something to key on; the actual envelope is still rendered by `errors.ts`.

## The auth seam

`request.user: AuthUser | null` is decorated on every request by verifying the bearer
access token and contains only `{ id }`. JWTs intentionally carry no role claim.
`requireAuth` is the authentication seam. `resolveCapability` loads the user and, when
its one-minute cache is stale, revalidates the retained user OAuth grant and guild member
directly with Discord. Protected routes use that result on a strict Basic < Moderator <
Admin ladder; Admin inherits Moderator.

## Discord auth

Why cookies lost to a bearer token in every deployment shape this project supports is in
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md#how-they-talk-to-each-other) — read
that first if something here seems arbitrary. This section is the practical surface.

### The flow

```text
Browser                    API                              Discord
  │  GET /api/v1/auth/discord/login?returnTo=...
  ├──────────────────────────▶│  sets state+PKCE cookie (Path=/callback)
  │◀── 302 to Discord ────────┤
  │                                                              │
  ├───────────────────── user logs in, consents ────────────────▶│
  │                                                              │
  │◀──────────────── 302 to GET /callback?code&state ────────────┤
  │  GET /callback?code&state │
  ├──────────────────────────▶│  checks state == cookie (constant-time)
  │                            │  exchanges code for a Discord token
  │                            │  fetches the Discord profile
  │                            │  upserts the user, mints a one-time login code
  │◀── 302 to frontend#pixelIndexLoginCode=... ───────────────────┤
  │                                                              │
  │  POST /api/v1/auth/token {code}         (ordinary CORS fetch, from here on)
  ├──────────────────────────▶│  consumes the code, mints access+refresh tokens
  │◀── { accessToken, refreshToken, user } ──┤
```

Two structurally different kinds of request happen here, and it is the reason the
whole thing works without a cookie ever crossing origins: `/login` and `/callback` are
**top-level navigations** — the API's own origin is the top-level site every time a
cookie is set or read, which is why an ordinary `SameSite=Lax` cookie is sufficient
there. `/token`, `/refresh` and `/logout` are **CORS fetches** from the SPA, which is
the part that actually crosses origins — and carries no cookie at all.

### Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/v1/auth/discord/login?returnTo=` | — | Starts the flow. `returnTo` must be an allowed web origin (`PUBLIC_WEB_ORIGIN`, or a `PUBLIC_WEB_ORIGIN_PATTERNS` match); anything else silently falls back to the first configured origin rather than becoming an open redirect |
| `GET /callback` | — | **Fixed path, not under `/api/v1`.** Must exactly match what is registered in the Discord Developer Portal |
| `POST /api/v1/auth/token` `{code}` | — | Exchanges a login code for a session. Single-use; a replay is a 401 |
| `POST /api/v1/auth/refresh` `{refreshToken}` | — | Rotates to a new pair. A reused (already-rotated) token revokes the whole session family — see below |
| `POST /api/v1/auth/logout` `{refreshToken}` | — | Revokes the family. Always 204, whether or not the token was valid — logout never leaks validity |
| `GET /api/v1/me` | bearer | Profile, current capability/cache age, and submission eligibility/invite for the caller |

### Refresh token rotation and theft detection

Every refresh **spends** the presented token and issues a new one in its place
(`auth_refresh_tokens.rotatedToId`). Presenting a token a second time — because it was
copied by an attacker, or because a client retried a request it thought had failed —
means neither the original holder's copy nor the replayer's can be trusted to be the
real one, so the **entire family is revoked**, not just that token.

Admin is configured with comma-separated Discord **user IDs** in `DISCORD_ADMIN_IDS`.
There is no local bootstrap promotion and no database role editor. With a guild enabled,
the user must also be a verified guild member; without one, the configured ID is enough
and normal self-hosted functionality stays available.

### Setting up the Discord application

1. <https://discord.com/developers/applications> → **New Application**.
2. **OAuth2** tab → note the **Client ID** and **Client Secret** → `DISCORD_CLIENT_ID` /
   `DISCORD_CLIENT_SECRET`.
3. **OAuth2 → Redirects** → add exactly `${PUBLIC_API_ORIGIN}/callback` — e.g.
   `https://api.pixel-index.example/callback`. This has to be byte-for-byte identical to
   what the API constructs from `PUBLIC_API_ORIGIN`, or Discord rejects the exchange with
   `invalid_client` for a reason that has nothing to do with whether your client secret
   is correct — a mismatch here and a wrong secret produce the *same* error from
   Discord, which fails late and confusingly.
4. With guild integration, Discord consent includes `guilds.members.read`; the API calls
   `/users/@me/guilds/{guild.id}/member` for role IDs and nickname. No bot, Pico, bot
   token, `guilds`, or email scope is used. See
   [`docs/discord-integration.md`](../../docs/discord-integration.md).

**A live credential fails the same way a wrong one does, and both look like an `invalid_client`
from Discord's side**, so if login rejects immediately: verify the pairing independently
of this codebase before debugging further —

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://discord.com/api/v10/oauth2/token \
  -u "$DISCORD_CLIENT_ID:$DISCORD_CLIENT_SECRET" \
  -d grant_type=client_credentials
```

`200` confirms the id/secret pair itself authenticates. Anything else (`401
invalid_client` in particular) means the secret does not belong to that client id —
often because it was reset in the Developer Portal after being copied, or a different
field (e.g. the Public Key) was pasted by mistake — and the fix is to generate a fresh
secret and update `.env`, before spending any time on the flow itself.

## The public layout API

No authentication anywhere in this section: reading is public, per the requirements.
Every query filters to `visibility = 'public'` before anything else — a hidden or
deleted layout is a **404**, identical to a slug that never existed, never a 403 that
would confirm something is there to hide.

| Route | Purpose |
|---|---|
| `GET /` | Developer landing page (JSON): what this API is, its own running commit (`API_COMMIT`, see the root `docs/deployment.md`), and pointers to `/docs` and `/openapi.json` for third-party integrators |
| `GET /api/v1/meta` | This API's own commit (`apiCommit`), the pinned Pixel Agents (version, commit, `layoutRevision`), and the public layout count |
| `GET /api/v1/tags` | Every tag in use on a public layout, with its count, most-used first — what the tag filter is populated from |
| `GET /api/v1/layouts` | List: filtered, sorted, keyset-paginated |
| `GET /api/v1/layouts/:slug` | Full record, including the parsed layout |
| `GET /api/v1/layouts/:slug/download` | The raw bytes, verbatim — `Content-Disposition: attachment` |
| `GET /api/v1/layouts/:slug/preview.png` | Proxied from the renderer, scale 1 |
| `GET /api/v1/layouts/:slug/thumbnail.png` | Proxied from the renderer, scale **1** — same bytes as `preview.png`, see below |
| `GET /openapi.json` | The OpenAPI 3.1 document, generated from the same schemas below |
| `GET /docs` | Swagger UI over the same document |

### List: filters, sorting, pagination

```text
GET /api/v1/layouts?author=<uuid>&tags=cosy,small&q=office&minCols=15&maxFurniture=80&sort=furniture&limit=24&cursor=…
```

| Param | Notes |
|---|---|
| `author` | A `users.id`. Click-an-author-name filtering uses the `author.id` a list/detail response already returns |
| `tags` | Comma-separated tag names. **ALL**, not any — each one narrows further, the same way the numeric ranges compose |
| `q` | Free text over title and description (the generated `search_vector` column) |
| `min*` / `max*` | `Cols`, `Rows` (the declared canvas), `Size` (occupied-footprint tile count, `visibleCols × visibleRows`, not `Cols`/`Rows` independently, and not the canvas either), `Furniture`, `Areas`, `Pets`, `Seats` — each inclusive at both ends |
| `sort` | `newest` (default), `furniture`, `largest` (`visibleCols × visibleRows`), `title` |
| `limit` | 1–100, default 24 |
| `cursor` | Opaque, from a previous page's `nextCursor` |

Every filter composes with every other — `author` + `tags` + a size range in one request
is tested directly (`src/layouts/query.test.ts`, "filters compose").

**Pagination is keyset (cursor-based), not `OFFSET`.** A layout published while someone
is on page 2 would silently shift an `OFFSET` page's contents — skip a row, repeat one.
A cursor pins to `(sortColumn, id)` on the last row of the page before it, so the next
page is stable regardless of what gets inserted anywhere else in the meantime; `id` is
there specifically because `sortColumn` alone is never a total order (two layouts can
tie on furniture count, on `createdAt`, on title). `total` is the count of everything
matching the filters, independent of the page size, for "N results" — see `src/layouts/query.ts`.

An unrecognised query parameter is a **400**, not a silently-ignored no-op — see
"a subtlety" below for why that took a deliberate Fastify override.

### Caching

`/layouts/:slug`, `/download`, `/preview.png` and `/thumbnail.png` are **slug**-addressed,
and a slug's content can change under it once an owner replace exists — so none of them
is `immutable`. Each sets `Cache-Control: public, max-age=60, must-revalidate` plus an
`ETag` (the layout's `sha256`, or the renderer's own content-addressed etag for the image
routes), and answers a matching `If-None-Match` with a bare `304`. This is different from,
and deliberately weaker than, the renderer's own cache — that one *is* keyed on content
and can be immutable forever, because a given (layout, upstream pin, scale) tuple can
only ever render one way.

### Why `thumbnail.png` asks the renderer for scale `1`, same as `preview.png`

A pre-shrunk render downscaled again by the browser to its actual card width is not
equivalent to one resize at that width — see `services/renderer/README.md`'s `scale`
section for the measurement. This route sends the full render and lets the browser do
the one resize that has the actual target size available.

### The OpenAPI document is generated, not maintained by hand

`src/layouts/schemas.ts` is the **single** definition of every request and response
shape. `@fastify/swagger` reads the same schema objects Fastify already uses to validate
requests and serialize responses, so the document at `/openapi.json` cannot describe a
shape the API doesn't actually produce — there is no second copy to let drift in. The
test suite goes one step further and validates real HTTP responses against those same
schema objects with `ajv` (`src/layouts/routes.test.ts`), which is what "the OpenAPI doc
matches actual responses" means as a checked fact rather than a claim.

### Versioning and deprecation

`/api/v1` is additive-only: new optional query parameters, new response fields, new
routes never remove or repurpose an existing one. A breaking change ships as `/api/v2`
alongside it, never in place of it. When `/v2` exists, `/v1` starts sending
`Deprecation: true` and `Sunset: <date>` headers with a documented removal date, giving
third parties (and our own frontend, which is intentionally just another consumer of
this same API) real notice rather than a surprise.

### Two query-handling subtleties

**Fastify silently *strips* unrecognised properties by default, even with
`additionalProperties: false`.** Ajv's `removeAdditional: true` (Fastify's out-of-the-box
setting) takes precedence over a schema's own `additionalProperties: false` — the
combination means "delete these quietly", not "reject them". For a filtering API that is
the worst possible failure mode: `?mincols=…` typo'd from `?minCols=…` would be dropped
and the caller would get a silently-unfiltered result instead of an error telling them
what they got wrong. `server.ts` sets `ajv: { customOptions: { removeAdditional: false } }`
so `additionalProperties: false` means what it says.

**`` `sql`= ANY(${array})` `` is not the same as `IN (…)` when the array comes from a plain
JS value via drizzle's `sql` template.** Drizzle expands a JS array into parenthesised
scalars (`($1, $2)`), and Postgres's `ANY()` operator requires an actual bound array on
its right-hand side — the combination throws `op ANY/ALL (array) requires array on right
side` **at query time**, not at compile time. The tags ALL-match filter
(`src/layouts/query.ts`) uses `sql.join(...)` to build a real `IN (…)` list instead.

## Submitting a layout

```text
POST /api/v1/layouts?title=<1-60 chars>&description=<0-300 chars>&tags=<comma,separated>
Authorization: Bearer <access token>
Content-Type: application/json

<the layout.json bytes, exactly>
```

The body **is** `layout.json` — not a field nested in a larger JSON envelope. Title,
description and tags travel as query parameters instead. That is not how a JSON API
would normally shape "upload a resource plus its metadata", and it is deliberate: nested
JSON gets re-serialised the moment it is parsed out of the envelope — different
whitespace, different number formatting — which would silently reintroduce the exact
byte-fidelity problem `layouts.raw` exists to solve, for the one field where it
matters most. `title`/`description`/`tags` genuinely are just metadata; the layout is the
resource, so it gets the whole body.

Making that work means this one route deliberately overrides Fastify's default
`application/json` body parser with one that keeps the raw string instead of an object —
scoped to an *encapsulated* child plugin (`app.register(async (instance) => …)`) so it
cannot leak into any other JSON route. `layouts/submit.test.ts` includes a regression
test proving `/api/v1/auth/token` still receives a normally-parsed body.

### What happens, in order

Everything cheap runs before anything expensive, so a bad request is rejected as early
as possible:

1. **Auth and capability.** `requireSubmissionCapability` verifies the bearer user and
   requires configured-guild membership from the short Discord cache or a direct API
   revalidation. An unguilded self-hosted instance accepts every authenticated user.
2. **Size.** `MAX_LAYOUT_BYTES`, checked on the raw string's byte length before
   `JSON.parse` ever runs — `413`.
3. **Is it JSON at all** — `400`.
4. **layout-core validation** — `createValidator()`'s full check (schema, grid
   consistency, furniture ids, `layoutRevision`) — `422` with field-level `issues`,
   exactly `@pixel-index/layout-core`'s `ValidationIssue[]`. A `layoutRevision` below the
   bundled default gets layout-core's own explanation of *why* it would break, not just
   that it did — see `packages/layout-core`.
5. **Dedupe**, by `sha256` — `409`.
6. **The daily cap**, a real count of the last 24h — `429 too_many_submissions`.
7. Slug generation, insert (in a transaction with tag attachment), then a best-effort
   render.

### Dedupe also stops a DIFFERENT owner resubmitting someone else's content

The `sha256` lookup (`findLayoutBySha256`) is **not** scoped to public layouts — it
checks every visibility. A layout that is currently `hidden`, or `deleted` and owned by
someone ELSE, still blocks a byte-identical resubmission with the same `409`, worded so
it does not confirm *why* ("was submitted before and is not available", never naming the
slug) — otherwise dedupe-by-content-hash would be exactly the mechanism someone could use
to quietly claim content that is not theirs.

The one deliberate exception (`isOwnersOwnDeleted`, shared by this route, `manage.ts`'s
`PUT .../layout`, and its `DELETE`): the SAME owner may always resubmit their own
`deleted` layout's exact bytes, even one a MODERATOR deleted (#72) — this is a policy
choice, not an oversight. There used to be a separate `removed` visibility specifically
so a moderator's decision could never be "laundered back in" this way, even by the
original owner; #72 retired it, so that specific guarantee is gone. Abuse is a
Discord-membership problem (losing submission rights), not something dedupe enforces.

### Render failure never blocks publication

After the transaction commits, this route asks the renderer for a preview and includes
`previewReady` in the response, but a renderer failure — down, timed out, or (should it
ever happen) rejecting a layout layout-core already accepted — is logged and does
**not** roll back or block the publication already committed. Coupling "can I submit" to
"is the renderer currently up" would let a secondary feature take down the core one, and
there is nothing to compensate for later regardless: the preview routes are a live proxy
with no stored state, so the very next viewer's request tries the renderer fresh no
matter what happened here. The one thing this call buys, beyond the immediate
`previewReady` signal, is a warm renderer cache by the time anyone looks.

### Slugs are random, not vanity — and freed the instant a layout stops holding them

Every submission gets a random, unpredictable slug (`slug.ts`): 10 lowercase hex
characters from a CSPRNG, regardless of the submitter's role. **Not** derived from the
title — a title-derived slug is a first-come-first-served vanity name, free for the
taking by anyone fast enough to submit it, which this design removes as an avenue of
abuse. A candidate is checked against `layouts.slug` regardless of visibility — a
`deleted` row still literally holds its slug value at rest, since the unique index
(schema.ts) is not visibility-aware — and retried on the (astronomically rare)
collision rather than stealing that row's slug; a manual vanity pick, unlike random
generation, is willing to do that (see below). A true race between two concurrent
submissions generating the same slug before either commits is retried (up to 3
attempts) rather than surfaced as the caller's problem.

A moderator can grant a vanity slug afterwards — `PATCH /api/v1/layouts/:slug` with
`{ "slug": "…", "reason": "…" }` (manage.ts), moderator-only even for the layout's own
owner, format-checked against layout-core's shared `SLUG_RE`. A slug currently held by a
`public` or `hidden` layout is a hard `409` — no silent `-2` suffix like an
auto-generated slug gets, since a moderator typing a specific string expects that string
or a clear rejection. A slug held by a `deleted` layout is **not** blocking:
that row is evicted to a fresh random slug in the same transaction as the claim, and the
requested string is handed to the new layout — the "reuse the same URL" case, where a
newer version of a design takes over the vanity slug a now-dead earlier version held.
Renaming away from a slug (vanity or not) frees it immediately for anyone, including the
same layout renaming back to it later, once nothing else has claimed it meanwhile. The
slug is never regenerated from a later title edit — it is a permanent, linkable,
downloadable URL, and silently moving it under a link someone already shared would be a
worse surprise than a slug that no longer matches a since-renamed title. There is no
redirect from an evicted/renamed-away slug to wherever it ends up next; the old URL 404s.

### A boot-time tension this route shares with `/meta`, and resolves the same way

Building the validator once at boot (rather than per request — `furnitureCatalog()`
walks the whole asset tree) raised the same question `/meta` already answered: what
happens if the pinned upstream cannot be found? Crashing the whole process over a
misconfigured `PIXEL_AGENTS_DIR` would take down every read route along with the one
route that actually needs it, so this degrades exactly like `/meta` does — logging loudly
at boot and answering every submission with a clear `503 validator_unavailable` instead of
either refusing to start or failing every request with a confusing, unrelated-looking
stack trace.

### Checking a layout before publishing: `POST /api/v1/layouts/preview-check`

The submit UI shows an author their layout rendered *before* they publish — an author
who can see their own layout rendered is far less likely to submit something broken,
which is what makes post-moderation (no review queue) tolerable at all. This is not a
new pipeline: same raw
byte-body handling, same `upstream.validator` (so the same actionable, field/furniture-id
-naming errors as the real `POST /api/v1/layouts`), then a direct proxy to the renderer —
just with nothing persisted. The renderer isn't itself reachable from a browser (no CORS
configured on it, deliberately — it is an internal service, not a public one), so this is
the only path a dry-run preview can take. A renderer failure here is a `502`, not the
publish-anyway fallback `POST /api/v1/layouts` uses — there is nothing to "publish
anyway" when nothing was going to be saved either way.

Unlike every other route in this file, this one is deliberately public — no
`requireSubmissionCapability`, no login at all. Nothing here is persisted, and Discord
community membership has no bearing on rendering a preview of bytes that were never
going to be saved, so the layout editor's create path (#85) can let an anonymous
visitor draw and preview before deciding whether to log in and publish. The write
rate-limit bucket (IP-keyed, not user-keyed) is the abuse guard in place of auth; if
that ever proves insufficient as the community grows, reinstating
`requireSubmissionCapability` here is a one-line change (see the comment at the route
in `submit.ts`).

### Verified against a real renderer, not just a stub

Beyond the unit and route-level suite (stubbed renderer), submission is also verified
against the **actual, built renderer image** end-to-end: a real login-free JWT signed
with the container's own `SESSION_SECRET`, `POST`ed to the live API, produces a `201`
with `previewReady: true`, a subsequent `GET .../preview.png` returns a genuine 736×768
rendered PNG (not a stub), `/download` is byte-identical to the exact bytes sent, a
resubmission of the same content correctly `409`s, and `/api/v1/meta`'s count
increments by one.

The route tests cover dedupe (both public and non-public cases), Discord submission
capability, and the daily cap.

`services/api/e2e/` runs this same check in CI on every push — see "Automated
end-to-end suite" further down.

## Editing, replacing, deleting and moderating a layout

```text
PATCH  /api/v1/layouts/:slug            edit title/description/tags; owner may also toggle
                                         public<->hidden on their own; moderator gets the
                                         same public/hidden toggle on anyone's, plus slug
PUT    /api/v1/layouts/:slug/layout     replace the layout.json content — owner-only
DELETE /api/v1/layouts/:slug            permanent removal — owner OR moderator, idempotent
GET    /api/v1/me/layouts               the caller's own layouts, every visibility
```

### One `PATCH`, not a separate moderator endpoint

Moderation was originally scoped as a separate report-intake API — `POST .../report`, a
queue of open reports, dedicated hide/restore routes. Instead: there is no report queue,
and a moderator hides or unhides a layout through the **same** `PATCH
/api/v1/layouts/:slug` an owner uses to fix a typo, not a parallel `/moderate` surface.
The difference between an owner's edit and a moderator's action is which fields the
request is allowed to touch, checked once per request:

- `visibility` (#72): settable to `public` or `hidden` only — by the layout's OWNER on
  their own layout, or by a MODERATOR on anyone's, including their own. Symmetric on
  purpose: there is no longer a third, moderator-only visibility value, so there is
  nothing left for the allowed-VALUES check to distinguish by actor. `deleted` is never a
  value this field accepts for either actor, current OR target state — see `DELETE`
  below for the only way in or out of it.
- `slug` is moderator-only, full stop — an owner can never set even their own layout's
  slug. See "Vanity slugs" below.
- A `reason` is required whenever the change is **not** the caller acting on their OWN
  layout: metadata edits, or a visibility toggle, on your own content needs no
  justification to yourself, whether you happen to be a moderator or not. Anyone editing
  someone ELSE's layout, or any slug change (moderator-only in the first place), is
  moderation, and "no silent moderation" means it is always attributed and explained.
- Every visibility transition maps onto `layout.hide` / `layout.unhide` in the audit log
  (`visibilityAuditAction()`, `manage.ts`), purely from the target value — there is only
  one direction left to distinguish now that `removed`/`restore` are gone. Identical
  whether the actor is the owner or a moderator; only `actorUserId`/`reason` on the row
  differ.

There used to be a third, moderator-only `removed` visibility here, with its own
`layout.remove`/`layout.restore` audit actions — folded by #72 into `DELETE`'s
`deleted` instead (see "`DELETE`: owner or moderator, permanent, idempotent" below).
`hidden` stays reversible by either actor;
`deleted` (via `DELETE`, now either actor) is never reachable from `PATCH` at all, for
either actor, current OR target state — see schema.ts's visibility-state table.

### Vanity slugs are moderator-granted, not self-service

Every submission is issued a random slug (see "Slugs are random, not vanity" above) —
no one, regardless of role, can pick their own at submission time. A moderator can grant
a memorable vanity slug afterwards through the same `PATCH` route: `{ "slug":
"severance-office", "reason": "…" }`. Format-checked against layout-core's shared
`SLUG_RE`. Whether the string is available depends on who currently holds it
(`manage.ts`, inside the same transaction as the rename):

- Held by a `public` or `hidden` layout: a hard `409`. No silent `-2` suffix, since a
  moderator typing a specific string expects that string or a clear rejection, not a
  surprise variant.
- Held by a `deleted` layout: **not** blocking. That row is evicted to a fresh random
  slug (`generateUniqueSlug`) in the same transaction, and a `layout.rename_slug` audit
  entry is recorded against it, attributed to the acting moderator — before the
  requested string is handed to the layout being patched. This is the "reuse the same
  URL" workflow: a newer submission of a design takes over the vanity slug a superseded,
  no-longer-public earlier version held, rather than getting a different URL for what a
  visitor experiences as the same layout.
- Held by nothing (including the same layout's own former slug, if it renamed away and
  nothing has claimed the string since): the claim just succeeds.

There is no redirect from wherever a slug used to point to wherever it ends up next —
the old URL simply 404s once its layout stops holding it, whether via a rename or an
eviction. Two rows can never literally share a slug value, not even briefly: the unique
index (`layouts_slug_key`, schema.ts) is not visibility-aware, which is also why a
`deleted` row's OWN slug column has to change, not just its visibility, for another
layout to use that string.

### `PUT .../layout` stays owner-only, even for a moderator

Replacing the *content* of a layout is never something moderation does on someone
else's behalf — a moderator who objects to the design hides or deletes it; they do not
rewrite someone else's submission. It shares the raw-body content-type parser trick and
the `layoutStats`/dedupe/render pipeline with `POST /layouts`, via the same
`upstreamValidator.ts` instance built once at boot. The same dedupe rule applies:
replacing with content that byte-matches one of the *same owner's* previously `deleted`
layouts is allowed, even a layout a MODERATOR deleted (#72) — only a match against
someone else's layout is a `409`.

### `DELETE`: owner or moderator, permanent, idempotent (#72)

There used to be a moderator-only `removed` visibility, set via `PATCH` the same way
`hidden` was, plus a separate owner-only `DELETE` reaching a *different*, also
irreversible `deleted` — two names for functionally the same outcome, gone-for-good and
never coming back. #72 retired `removed`: a moderator now reaches the exact same
`deleted` outcome an owner always has, through this same `DELETE`, rather than a second
value under a different name depending on who acted. `manage.ts`'s route comment:

- `!isOwner && !isModerator` → `403`, same gate as `PATCH`.
- Already `deleted` → a silent idempotent `204`, matching `/auth/logout`'s existing
  idempotent-DELETE precedent, no reason needed even for a moderator re-issuing the same
  call — nothing changed, nothing to attribute.
- Deleting someone ELSE's layout needs a `reason` (`{ "reason": "…" }` body) — "no silent
  moderation" (#10), same rule as `PATCH`. Deleting your OWN needs none, moderator or
  not — same reasoning as `PATCH`'s owner visibility toggle. There is deliberately no
  `body` JSON Schema on this route (unlike `PATCH`) so that an owner's historically
  bodiless call — no `Content-Type`, no payload at all — keeps working exactly as
  before; `reason` is read and length-checked by hand instead (`readOptionalReason()`).
- The dedupe exception above (`isOwnersOwnDeleted`) does not distinguish WHO deleted a
  layout — a moderator-deleted one is exactly as resubmittable by its original owner as
  a self-deleted one. This is a deliberate policy choice, not an oversight: the
  anti-laundering guarantee `removed` used to provide (nobody, not even the original
  owner, could resubmit moderator-removed content) is gone. Abuse of the reopened path —
  an owner repeatedly resubmitting content a moderator keeps having to delete — is
  handled the same way the issue that introduced this (#72) describes: losing Discord
  guild membership loses submission capability entirely, upstream of anything this API
  enforces.

### `GET /me/layouts`

The owner's own list, reusing the public list's exact sort/cursor pagination machinery
(`ListLayoutsScope`, `query.ts`) with a different base filter — `authorUserId = caller`,
no visibility filter — instead of a second, parallel pagination implementation. Returns
`OwnerLayoutView`: the public shape plus `visibility`, `visibilityReason` and
`visibilityChangedAt`, so an owner can see *why* something of theirs is hidden.

## Discord capabilities and the user directory

Pixel Index does not grant/revoke roles or block accounts locally. Discord is the source
of membership and capability: guild membership grants Basic, configured moderator role
IDs grant Moderator, and configured Discord user IDs grant Admin. Removing/banning a
member stops new submissions, edits, replacements, and privileged actions after the
short cache expires. Existing public layouts stay public; layout visibility remains a
separate moderation decision.

```text
GET /api/v1/admin/users?q=<text>&capability=user|moderator|admin
```

This Admin-only endpoint is a read-only directory of non-system users that already have a
Pixel Index row. It never enumerates the guild. Each result contains the public profile,
last cached Basic/Moderator/Admin capability, observation timestamp, and layout count
across all visibilities. Raw Discord IDs, role IDs, and membership are not returned.

The implementation and frontend rights table live in
[`docs/discord-integration.md`](../../docs/discord-integration.md); moderation judgment
lives in [MODERATORS.md](../../docs/MODERATORS.md).

### No report-intake queue

There is no report intake, no queue, and no `reports` table writer — moderators act
directly through `PATCH` above. The `reports` schema and its audit actions stay in the
schema, unused — cheap to keep, and not worth a migration to remove for a table nothing
writes to yet.

### Finding something to moderate: `GET /api/v1/moderation/layouts`

`PATCH /api/v1/layouts/:slug` (above) is how a moderator **acts** on a layout;
`GET /api/v1/moderation/layouts` (moderator-minimum) is how they **find** one to act
on. It is the public list with the one constraint that defines "public" removed: every
author, every visibility, optionally narrowed to exactly one
(`?visibility=hidden` to see what's already been actioned, `?visibility=public` with a
`q=` to go looking for something that shouldn't be). Same filters, same keyset
pagination, same sort keys as the public list — a moderator's browse experience is not a
different tool, just an unfiltered one.

### Security regression coverage

The owner-or-moderator gate on `PATCH` and the dedupe-excludes-`deleted` fix (both `POST
/layouts` and `PUT .../layout`) have direct regression coverage. Discord capability
tests additionally cover encrypted grants, role precedence, cache age, nonmembership,
reauthorization, and outage behavior.

One of those mutation passes caught a real bug, not just proved a test's anchoring: the
first version of the dedupe-excludes-`deleted` fix excluded a `deleted` match
unconditionally, so a stranger with a copy of the exact bytes of *anyone's* withdrawn
layout could republish it as their own. Only "the SAME owner republishing their own
withdrawn content" is what schema.ts documents. Caught during the live end-to-end pass
below — not by the unit suite, which had only ever exercised the same-owner case — the
fix now checks `duplicate.authorUserId ===` the submitting user, and a cross-owner
regression test (`submit.test.ts`, "still rejects a STRANGER…") was added and
mutation-tested alongside it.

## Docker

```bash
# Context is the repo root.
docker build -f services/api/Dockerfile -t pixel-index-api .
```

`docker-entrypoint.sh` runs `db/migrate.js` **before every start**, not just the first —
migrations are forward-only and idempotent, so this is what makes a self-hoster's first
`docker compose up` provision a working database with no manual step, and makes a restart
after a schema-bumping deploy just work.

`drizzle-kit` and the rest of the dev toolchain are pruned from the runtime image
(`npm prune --omit=dev`) — they never run in production.

The image also carries `vendor/pixel-agents/package.json` and its
`webview-ui/public/assets` — nothing else, no `node_modules`, no webview source — so
`GET /api/v1/meta` can report a real pinned version via `@pixel-index/layout-core`. This
is a much smaller slice of upstream than the renderer needs, because the API only reads
metadata; it never boots upstream's dev server the way the renderer does.

Against a real containerised Postgres 17: migrations apply on first boot, `/ready`
succeeds, `/ready` fails within milliseconds when Postgres is stopped (fails fast — this
does not wait for the 2s timeout, because `pg` rejects a refused connection immediately),
a restart re-runs migrations idempotently, the image reports `healthy`, and `SIGTERM`
stops the container with exit `0` in under 0.3s. The layout routes hold up the same way:
`/api/v1/meta` reports the real build-arg commit, list/detail/download all round-trip
correctly, `/download` is **byte-identical** to the source file on disk, a 404 renderer
(`RENDERER_URL` pointed at nothing) produces a real `502` rather than a hang or a crash,
and `/openapi.json` names its schemas `LayoutSummary`/`LayoutDetail` rather than the
default `def-0`/`def-1` — see "two subtleties" above.

### Automated end-to-end suite

```text
services/api/e2e/docker-compose.yml   Postgres + the real renderer + API images
services/api/e2e/run.ts               the assertions — one full owner+admin session
services/api/e2e/e2e.sh               build, bring the stack up, run run.ts, always tear down
```

```bash
npm run test:e2e --workspace @pixel-index/api        # needs Docker
npm run typecheck:e2e --workspace @pixel-index/api    # e2e/run.ts on its own tsconfig
```

`services/api/e2e/` automates the same verification shape — the real, built Docker
images, a real Postgres, no stubbed renderer — as something that runs unattended, on
every push and PR (`api-e2e` job, `.github/workflows/ci.yml`). `run.ts` inserts test
users directly via `pg` (no Discord OAuth needed — access tokens are just
HS256 JWTs, signed with the same `signAccessToken` the API itself uses) and drives the
full flow over real HTTP: submit, edit, moderate, replace, delete, the cross-owner
dedupe fix, the read-only Admin directory, and removal of stale account-action routes. It is deliberately
a plain top-to-bottom script rather than vitest — nothing in it is an independent unit,
it all shares one running stack, and unit coverage of the same individual guards already
lives in `manage.test.ts` and `users/routes.test.ts`; this suite exists to prove the
real images actually boot, migrate, and talk to each other, which no amount of
PGlite-and-a-stub coverage can.

## The database

```text
src/db/schema.ts      the tables, and why they are shaped that way
src/db/client.ts      pool + Drizzle handle from DATABASE_URL
src/db/migrate.ts     container entrypoint: apply pending migrations, exit
src/db/seed.ts        container entrypoint: load seed/ if the database is empty, exit
migrations/           generated SQL, forward-only
```

```bash
export DATABASE_URL=postgres://user:pass@host:5432/pixel_index

npm run build && npm run db:migrate   # what the container does
npm run db:migrate:dev                # same thing, straight from src/
npm run db:generate                   # after editing schema.ts
npm test                              # against a real Postgres, in-process
```

Migrations are **forward-only and idempotent**. Drizzle records what it applied in
`drizzle.__drizzle_migrations` and skips it, so running the entrypoint on every boot is
safe and is the intended usage — that is what makes a self-hoster's first
`docker compose up` provision a working database with no manual step. There is no
`down`; rolling back a schema change means writing the next migration.

### Seeding

`docker-entrypoint.sh` runs `seed.ts` immediately after migrations, on every boot, not
just the first. It is a no-op the moment **any** layout exists — seeded or not — so a
self-hoster who has since published real content never gets it silently supplemented on
a restart; this only ever fills a genuinely empty table.

The repo root's `seed/<slug>/{layout.json,meta.json}` is copied into the image at build
time (`services/api/Dockerfile`) and loaded with the same `layout-core` validation a real
submission goes through — a seed layout the API itself would reject fails the boot
loudly rather than publishing something broken. Seed layouts have no Discord account
behind them: they belong to the synthetic system user (`SYSTEM_USER_ID`, see below) with
the human credit in `authorDisplay`, and are otherwise ordinary rows — moderatable,
editable by an admin acting through the same tools as anything else, no special case
anywhere else in the codebase.

## Decisions worth knowing before you write a query

**Post-moderation.** `visibility` defaults to `public` on insert. There is no approval
queue — the queue is the *report* queue.

**Three visibility states, not a boolean:**

| state | set by | reversible | slug reserved | in public API |
|---|---|---|---|---|
| `public` | — | — | yes | yes |
| `hidden` | owner or moderator | yes, by either | yes | no |
| `deleted` | owner or moderator (#72) | no | yes | no |

An owner can toggle their own layout `public`<->`hidden` freely, including undoing a
moderator's `hidden` — but can never reach `deleted`'s current OR target state through
`PATCH`; that is `DELETE`-only. See "One `PATCH`, not a separate moderator endpoint"
above for the exact rule and why. There used to be a fourth, moderator-only `removed`
state occupying the same "gone for good" niche as `deleted` under a different name;
retired by #72 — see "`DELETE`: owner or moderator, permanent, idempotent" above.

A byte-identical resubmit is allowed once a layout is `deleted`, but only by the SAME
owner — even if a MODERATOR was the one who deleted it (#72's deliberate policy choice,
see "Dedupe also stops a DIFFERENT owner..." above). A different owner resubmitting the
same bytes, or a `hidden` layout's owner doing so, is still a `409`. The row always
survives regardless, because slug reuse by a different author is a quiet impersonation
vector.

**Seed layouts have a real owner.** Git-versioned seed layouts have no Discord account
behind them. Rather than a nullable
owner — which would force every permission check and join to handle null — they belong
to a synthetic system user created by migration 0002 at a fixed id
(`SYSTEM_USER_ID`). A check constraint guarantees nothing can authenticate as it, and
`layouts.author_display` carries the human credit.

**Stats are denormalised from `@pixel-index/layout-core`.** `layoutStats()` is the single
source of truth for `cols`, `rows`, `visible_cols`, `visible_rows`, `furniture_count`,
`area_count`, `pet_count`, `carpet_count`, `seat_count` and `layout_revision`, and must
be applied on every write. A test asserts the stored columns equal what `layoutStats()`
returns for a real layout, so the two cannot drift.

`seat_count` (how many mock agents the live preview's slider allows) is the one
denormalised stat that needs the furniture catalog, not just the layout's own
JSON — a seat is a footprint tile of a chair-category item (`layoutStats()`'s `seats`
mirrors upstream's own `layoutToSeats()`, so a multi-tile item like a SOFA counts as more
than one seat). That is also why a schema migration alone cannot backfill it for rows
written before the column existed: `db/backfill-seats.ts` recomputes it from each row's
stored `layout` column and corrects any that disagree, run once per boot from
`docker-entrypoint.sh` alongside `migrate.ts` and `seed.ts`, idempotently.

`visible_cols`/`visible_rows` is the bounding box of every non-`VOID` tile — the
occupied footprint, as opposed to `cols`/`rows`, the declared canvas allocation; the
gallery, `largest` sort and `size` filter all read it, not `cols`/`rows`, since two
layouts can share an identical declared canvas while looking nothing alike.
`layoutStats()` computes both — the same bounding-box algorithm the live-office preview
already uses to frame its camera (`apps/web/src/live-office/PreviewApp.tsx`), shared
rather than reimplemented, via `occupiedBounds()`. Backfilled the same way as
`seat_count`, by `db/backfill-visible-bounds.ts`, also wired into `docker-entrypoint.sh`.

**`search_vector` is a generated column**, not something the application maintains, so it
can never disagree with the title and description it indexes.

## The audit log is append-only in the database

A trigger rejects `UPDATE`, `DELETE` and `TRUNCATE` on `moderation_actions`. The
requirement was "no update/delete path in application code", but a convention like that
rots the first time someone writes a cleanup script, and an audit log that can be quietly
rewritten is not an audit log.

**Neither `target_id` nor `actor_user_id` is a foreign key**, deliberately. History has
to outlive what it describes — a removal that erased its own evidence would defeat the
purpose. There is also a sharp edge here: `ON DELETE SET NULL` is itself an `UPDATE`, so
with a real FK the trigger would fire and **deleting any user who had ever moderated
anything would fail outright**. `actor_label` and the `before`/`after` snapshots are what
keep a row legible once its subjects are gone.

Reconstructing a layout's history is one query:

```sql
SELECT * FROM moderation_actions
WHERE target_type = 'layout' AND target_id = $1
ORDER BY created_at;
```

## Indexes

Every public read path filters on visibility first, so the layout-listing and tag-filter
indexes are **partial** (`WHERE visibility = 'public'`). They stay small as hidden and
deleted rows accumulate. Verified against Postgres 17 with 20k rows across 60 authors:
listing uses `layouts_public_created_idx`, author filtering uses
`layouts_public_author_idx`, dedupe uses `layouts_sha256_idx`, and full-text search uses
the partial GIN `layouts_public_search_idx`. `layouts_author_idx` is deliberately *not*
partial, because owner dashboards list hidden rows too.

**`layouts_public_furniture_idx` and `layouts_public_title_idx`**, each ending in `id` as
a tiebreaker, exist for the same reason `layouts_public_created_idx` does — they make
keyset pagination on those sort orders a fully covered index scan rather than a
sort-then-filter. The `largest` sort (`visibleCols × visibleRows`) has no dedicated
index yet — at the dataset sizes this index is targeting, a plain `ORDER BY` is not a
concern.

**`layouts.raw` exists for byte fidelity.** Postgres's `jsonb` type does not round-trip
byte-identically — it collapses whitespace and normalises number literals on write — so
`JSON.stringify()` of the parsed `layout` column is not guaranteed to reproduce what a
contributor's own `sha256sum layout.json` was computed over. `raw` holds the exact bytes
as uploaded or seeded; `GET /layouts/:slug/download` serves `raw` verbatim, and `sha256`
is computed over `raw`, not over a re-serialised `layout`. This is what makes "byte-for-byte
what Pixel Agents exported" and "`sha256` is public so a third party can dedupe" true
rather than aspirational — see `schema.test.ts`, "`raw` round-trips byte-for-byte".

## Tests

`npm test` runs against **PGlite** — Postgres compiled to WASM, in-process. Triggers,
generated columns, partial indexes, enums and check constraints all behave as they will
in production, and no Docker or CI service container is needed. A mocked database would
prove none of it, and every acceptance criterion for this schema is about behaviour the
engine provides.

The migration entrypoint itself is additionally verified end-to-end against a real
Postgres 17 container, since the tests exercise the PGlite driver rather than
`node-postgres`. The same real-Postgres check covers the auth migration
(`auth_refresh_tokens`, `auth_login_codes`) too: tables land, check constraints apply,
and a second run is a no-op.

`auth/routes.test.ts` runs the **entire OAuth flow through real HTTP route handlers**
(`app.inject`) against a migrated PGlite database, stubbing only the outbound call to
Discord's API — login → callback → code exchange → `/me` → refresh → logout. Discord's
own confidential-client details (Basic-auth header shape, token endpoint contract) are
exercised separately in `auth/discord.test.ts`.

Three properties central to session security are **mutation-tested**, not just covered
— the guard was deleted and the relevant test confirmed to fail before being restored:
refresh-token reuse detection, OAuth `state` comparison, and the `returnTo` origin
allowlist. A green test suite proves the code runs; deleting the check and watching the
right test go red is what proves the test is actually anchored to the security property
it claims to guard, not merely exercising the code path around it. The public layout API
applies the same discipline to its own three easiest-to-silently-break properties: the
tags ALL-match filter, the visibility filter
(never returning a hidden/deleted layout), and the cursor's sort-mismatch rejection.

`layouts/routes.test.ts` runs the **whole public layout API through real HTTP route
handlers** against a migrated PGlite database, including the renderer proxy — with only
the outbound call to the renderer stubbed (`vi.stubGlobal('fetch', …)`), the same pattern
`auth/routes.test.ts` uses for Discord. `layouts/query.test.ts` covers filter composition,
all four sort orders, and keyset pagination directly at the SQL layer — including a test
that inserts a new highest-ranked row *between* two page requests and asserts page 2 is
unaffected, which is the specific failure `OFFSET` pagination cannot avoid.

The public layout API is also verified against a real containerised Postgres 17 with a
real seed layout: `/api/v1/meta` reports the real build-arg-supplied commit, `/download`
is **byte-identical** to the source file on disk, and a `RENDERER_URL` pointed at
nothing produces a real `502` from the live container, not a hang.

`layouts/submit.test.ts` and `layouts/slug.test.ts` cover submission the same way — real
HTTP handlers, PGlite, a stubbed renderer — and go one step further:
the **actual, built renderer image** rendered a real submission end-to-end (a genuine
736×768 PNG, not a stub) against the live API and a real Postgres container — see
"Submitting a layout" above for what that checked. Dedupe (both the public and the
non-public/laundering case), the Discord submission gate and the daily cap are covered by route tests.

`layouts/manage.test.ts` and `users/routes.test.ts` cover owner/moderator layout actions
and the read-only Admin directory through real HTTP handlers and migrated PGlite. The
Discord grant/capability suites cover encryption, refresh, membership, role precedence,
and stale-cache behavior.

## A note on `drizzle-kit`

`drizzle-kit` is a **devDependency** that turns `schema.ts` into SQL and never runs in
production — the container applies the generated SQL with drizzle-orm's migrator, so it
is not installed in the runtime image. It pulls a deprecated `@esbuild-kit/*` chain with
a moderate advisory against esbuild's dev server, which `drizzle-kit generate` does not
start; `npm audit --omit=dev` — the tree that actually ships — reports zero
vulnerabilities, and `services/api`'s own image is pruned to production dependencies
before the runtime stage, so `drizzle-kit` and its dev-only chain never ship at all.
