/** JSON Schemas for the custom-assets routes — same $ref-shared-component pattern as layouts/schemas.ts. */

const filesSchema = {
  type: 'object',
  properties: { sprite: { type: 'string' } },
  required: ['sprite'],
} as const;

export const customAssetSummarySchema = {
  $id: 'CustomAssetSummary',
  type: 'object',
  properties: {
    assetId: { type: 'string' },
    assetKind: { type: 'string', enum: ['furniture', 'character', 'pet'] },
    name: { type: 'string' },
    // Furniture only (#105) — null for characters and pets.
    category: { type: ['string', 'null'] },
    // 'builtin' for the bundled Pixel Agents catalog (synced by builtinSync.ts), 'custom' for an upload.
    source: { type: 'string', enum: ['builtin', 'custom'] },
    author: { $ref: 'PublicAuthor#' },
    // Real, user-facing classifiers (assets/tags.ts) — orientation,
    // static/animated, interactable. Replaces variantCount, removed.
    tags: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    files: filesSchema,
  },
  required: [
    'assetId',
    'assetKind',
    'name',
    'category',
    'source',
    'author',
    'tags',
    'createdAt',
    'updatedAt',
    'files',
  ],
} as const;

export const customAssetDetailSchema = {
  $id: 'CustomAssetDetail',
  type: 'object',
  allOf: [
    { $ref: 'CustomAssetSummary#' },
    {
      type: 'object',
      properties: {
        // Flattened CatalogEntry[] — pixel-agents' own shape, not ours to constrain further.
        manifest: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['manifest'],
    },
  ],
} as const;

/** Registered alongside `layouts/schemas.ts`'s `sharedSchemas` — assumes `PublicAuthor#` is already registered. */
export const assetSharedSchemas = [customAssetSummarySchema, customAssetDetailSchema] as const;

export const listCustomAssetsQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 24 },
    cursor: { type: 'string' },
    assetKind: { type: 'string', enum: ['furniture', 'character', 'pet'] },
    category: { type: 'string' },
    // 'builtin' for the bundled Pixel Agents catalog, 'custom' for an upload.
    source: { type: 'string', enum: ['builtin', 'custom'] },
    // A Discord user id (snowflake), same convention as /api/v1/layouts?author=.
    author: { type: 'string' },
    // The tag facet filter (assets/tags.ts): OR within each facet ("front OR
    // back"), AND across the three facets present — see query.ts's
    // buildConditions for the semantics and why this is deliberately NOT
    // layouts' single all-tags-are-ANDed model.
    orientation: {
      type: 'string',
      description: 'Comma-separated orientation tags (front/back/left/right/side); matches ANY of them.',
    },
    animation: {
      type: 'string',
      description: 'Comma-separated of "static" and/or "animated"; matches ANY of them.',
    },
    interactable: { type: 'string', enum: ['true', 'false'] },
  },
} as const;

export const listCustomAssetsResponseSchema = {
  200: {
    type: 'object',
    properties: {
      schemaVersion: { type: 'integer' },
      total: { type: 'integer' },
      assets: { type: 'array', items: { $ref: 'CustomAssetSummary#' } },
      nextCursor: { type: ['string', 'null'] },
    },
    required: ['schemaVersion', 'total', 'assets', 'nextCursor'],
  },
} as const;

export const assetIdParamsSchema = {
  type: 'object',
  properties: { assetId: { type: 'string', pattern: '^[A-Z][A-Z0-9_]*$' } },
  required: ['assetId'],
} as const;

export const customAssetDetailResponseSchema = {
  200: { $ref: 'CustomAssetDetail#' },
} as const;

/**
 * `character` is a real `assetKind` (#105) but has no `manifest.json` at all
 * — it's kept in the enum so a request for it 404s with a clear "no schema
 * for this kind" message instead of a generic 400 for an unrecognized kind.
 */
export const assetSchemaKindParamsSchema = {
  type: 'object',
  properties: { kind: { type: 'string', enum: ['furniture', 'character', 'pet'] } },
  required: ['kind'],
} as const;

/**
 * The response body IS the published JSON Schema document itself
 * (`packages/layout-core/schema/custom-asset-*-manifest.schema.json`, #107)
 * — deliberately not wrapped in an envelope, so a consumer can feed the
 * response straight to their own schema validator (`ajv.compile(await
 * response.json())`) without unwrapping it first.
 */
export const assetManifestSchemaResponseSchema = {
  200: { type: 'object', additionalProperties: true },
} as const;

/**
 * The response body for `/frames` — one entry per visually distinct pose
 * (`poses.ts`'s `AssetPose[]`), each carrying its own frames as embedded PNG
 * data URLs so the client never has to make a second round trip per frame.
 */
export const assetFramesResponseSchema = {
  200: {
    type: 'object',
    properties: {
      schemaVersion: { type: 'integer' },
      poses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            label: { type: 'string' },
            mirror: { type: 'boolean' },
            frames: { type: 'array', items: { type: 'string' } },
          },
          required: ['key', 'label', 'frames'],
        },
      },
    },
    required: ['schemaVersion', 'poses'],
  },
} as const;

export const customAssetCatalogResponseSchema = {
  200: {
    type: 'object',
    properties: {
      schemaVersion: { type: 'integer' },
      catalog: { type: 'array', items: { type: 'object', additionalProperties: true } },
      sprites: { type: 'object', additionalProperties: true },
    },
    required: ['schemaVersion', 'catalog', 'sprites'],
  },
} as const;

/**
 * `assetKind`, `category`, and `name` are NOT accepted here (#105 follow-up)
 * — all three are already inside the zip itself: every kind's manifest now
 * carries `name` (and furniture's carries `category`), so `submit.ts` decodes
 * (and, in doing so, detects the kind of) the zip's own contents instead of
 * trusting a caller-supplied value that could disagree with what's actually
 * uploaded.
 */
export const submitCustomAssetQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // Required only for an X-Api-Key-authenticated (bot-originated) upload —
    // see submit.ts. A web upload attributes to the caller's own session and
    // must not supply this.
    discordUserId: { type: 'string', pattern: '^\\d{17,20}$' },
  },
} as const;
