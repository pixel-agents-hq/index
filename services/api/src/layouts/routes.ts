/**
 * The public layout API — the contract third parties integrate against, and
 * what our own frontend consumes too, so it never has a backend-for-frontend
 * shortcut this API itself lacks. No auth anywhere in this file: reading is
 * public, per the requirements, and every query already filters to
 * `visibility = 'public'` (query.ts) — a hidden or deleted layout is 404,
 * indistinguishable from a slug that never existed.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ApiConfig } from '../config.js';
import type { AnyDatabase } from '../db/client.js';
import { ApiError } from '../errors.js';
import type { RequestSchemas } from '../http.js';
import { requestPreview } from '../renderer/client.js';
import { customAssetsForLayout } from '../renderer/customAssets.js';
import { PUBLIC_REVALIDATED, respondNotModifiedIfMatching } from './caching.js';
import {
  authorForLayout,
  authorsForLayouts,
  getLayoutBySlug,
  listLayouts,
  listPublicTags,
  type NumericRange,
  tagsForLayouts,
} from './query.js';
import type { ListLayoutsBody, ListTagsBody } from './responses.js';
import {
  layoutDetailResponseSchema,
  listLayoutsQuerySchema,
  listLayoutsResponseSchema,
  listTagsResponseSchema,
  slugParamsSchema,
} from './schemas.js';
import { toDetail, toSummary } from './serialize.js';

export interface LayoutRoutesDeps {
  config: ApiConfig;
  db: AnyDatabase;
}

const SCHEMA_VERSION = 1;

function range(min: number | undefined, max: number | undefined): NumericRange | undefined {
  if (min === undefined && max === undefined) return undefined;
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

export function registerLayoutRoutes(app: FastifyInstance, { config, db }: LayoutRoutesDeps): void {
  // Types for `request.query`/`params`/`body` come from the JSON Schemas already
  // on each route below, instead of being restated as an interface and cast to.
  // `withTypeProvider` is compile-time only — it changes no runtime behaviour and
  // no schema — so the two can no longer drift apart in silence.
  const typed = app.withTypeProvider<RequestSchemas>();

  typed.get(
    '/api/v1/layouts',
    { schema: { querystring: listLayoutsQuerySchema, response: listLayoutsResponseSchema } },
    async (request): Promise<ListLayoutsBody> => {
      const query = request.query;
      const tags = query.tags
        ? query.tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
        : undefined;

      // Each range is computed once into a local. Calling range() twice per
      // filter — once for the guard, once for the value — is what stopped
      // TypeScript narrowing the spread away from `NumericRange | undefined`.
      const colsRange = range(query.minCols, query.maxCols);
      const rowsRange = range(query.minRows, query.maxRows);
      const sizeRange = range(query.minSize, query.maxSize);
      const furnitureRange = range(query.minFurniture, query.maxFurniture);
      const areasRange = range(query.minAreas, query.maxAreas);
      const petsRange = range(query.minPets, query.maxPets);
      const seatsRange = range(query.minSeats, query.maxSeats);

      const { rows, total, nextCursor } = await listLayouts(db, {
        // No `?? 24` / `?? 'newest'`: the schema declares those defaults and
        // Fastify's ajv applies them, so the fallbacks were dead — which is
        // exactly what the schema-derived types now say.
        sort: query.sort,
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        filters: {
          ...(query.author ? { authorDiscordId: query.author } : {}),
          ...(tags && tags.length > 0 ? { tags } : {}),
          ...(query.q ? { q: query.q } : {}),
          ...(colsRange ? { cols: colsRange } : {}),
          ...(rowsRange ? { rows: rowsRange } : {}),
          ...(sizeRange ? { size: sizeRange } : {}),
          ...(furnitureRange ? { furniture: furnitureRange } : {}),
          ...(areasRange ? { areas: areasRange } : {}),
          ...(petsRange ? { pets: petsRange } : {}),
          ...(seatsRange ? { seats: seatsRange } : {}),
        },
      });

      const [authors, tagsByLayout] = await Promise.all([
        authorsForLayouts(db, rows.map((row) => row.authorUserId)),
        tagsForLayouts(db, rows.map((row) => row.id)),
      ]);

      return {
        schemaVersion: SCHEMA_VERSION,
        total,
        layouts: rows.map((row) =>
          toSummary(row, authors.get(row.authorUserId) ?? null, tagsByLayout.get(row.id) ?? []),
        ),
        nextCursor,
      };
    },
  );

  app.get('/api/v1/tags', { schema: { response: listTagsResponseSchema } }, async (): Promise<ListTagsBody> => {
    const tags = await listPublicTags(db);
    return { schemaVersion: SCHEMA_VERSION, tags };
  });

  typed.get(
    '/api/v1/layouts/:slug',
    { schema: { params: slugParamsSchema, response: layoutDetailResponseSchema } },
    async (request, reply) => {
      const { slug } = request.params;
      const layout = await getLayoutBySlug(db, slug);
      if (!layout) throw ApiError.notFound(`No public layout "${slug}".`);

      // Slug-addressed, and a layout's content can change under it (#9), so
      // this is short-lived + revalidated, not "immutable" — unlike the
      // renderer's own content-addressed cache.
      reply.header('cache-control', PUBLIC_REVALIDATED);
      if (respondNotModifiedIfMatching(request, reply, `"${layout.sha256}"`)) return;

      const [author, tags] = await Promise.all([
        authorForLayout(db, layout.authorUserId),
        tagsForLayouts(db, [layout.id]).then((map) => map.get(layout.id) ?? []),
      ]);
      return toDetail(layout, author, tags);
    },
  );

  typed.get(
    '/api/v1/layouts/:slug/download',
    { schema: { params: slugParamsSchema } },
    async (request, reply) => {
      const { slug } = request.params;
      const layout = await getLayoutBySlug(db, slug);
      if (!layout) throw ApiError.notFound(`No public layout "${slug}".`);

      reply.header('cache-control', PUBLIC_REVALIDATED);
      if (respondNotModifiedIfMatching(request, reply, `"${layout.sha256}"`)) return;

      // The exact bytes as uploaded, verbatim — see schema.ts on why this is
      // `raw` and not a re-stringified `layout`.
      return reply
        .header('content-type', 'application/json')
        .header('content-disposition', `attachment; filename="${slug}.json"`)
        .send(layout.raw);
    },
  );

  async function servePreview(request: FastifyRequest, reply: FastifyReply, slug: string) {
    const layout = await getLayoutBySlug(db, slug);
    if (!layout) throw ApiError.notFound(`No public layout "${slug}".`);

    const customAssets = await customAssetsForLayout(db, layout.layout);
    const outcome = await requestPreview(config.rendererUrl, layout.layout, { customAssets });
    if (!outcome.ok) {
      request.log.warn({ err: outcome.error, slug }, 'preview render failed');
      if (outcome.error.kind === 'invalid_layout') {
        // A stored layout failing validation means it was written badly, not
        // that the client asked for something wrong — that is our bug.
        throw new ApiError(500, 'internal_error', 'This layout could not be rendered.');
      }
      throw new ApiError(502, 'renderer_unavailable', outcome.error.message);
    }

    // Slug-addressed like the routes above, so the same short-lived,
    // revalidated policy applies — never the renderer's own "immutable",
    // which is only true for its content-addressed cache key, not for this URL.
    reply.header('cache-control', PUBLIC_REVALIDATED);
    const etag = outcome.result.etag ?? `"${layout.sha256}"`;
    if (respondNotModifiedIfMatching(request, reply, etag)) return;

    return reply.header('content-type', outcome.result.contentType).send(outcome.result.body);
  }

  typed.get('/api/v1/layouts/:slug/preview.png', { schema: { params: slugParamsSchema } }, (request, reply) => {
    const { slug } = request.params;
    return servePreview(request, reply, slug);
  });

  typed.get(
    '/api/v1/layouts/:slug/thumbnail.png',
    { schema: { params: slugParamsSchema } },
    (request, reply) => {
      const { slug } = request.params;
      // Same bytes as preview.png, not a separately rendered 0.25-scale PNG:
      // measured (see services/renderer/README.md) that pre-shrinking on the
      // server and then letting the gallery grid's CSS scale that already-
      // shrunk bitmap again to fit a responsive card width throws away real
      // pixel information a single direct scale from the full render would
      // have kept — 12% of pixels differed from a one-step resize in testing.
      // `image-rendering: pixelated` (apps/web) does the one and only resize,
      // at the one size that actually matters: however big the card is.
      return servePreview(request, reply, slug);
    },
  );
}
