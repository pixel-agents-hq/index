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
    author: { $ref: 'PublicAuthor#' },
    variantCount: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    files: filesSchema,
  },
  required: ['assetId', 'assetKind', 'name', 'category', 'author', 'variantCount', 'createdAt', 'updatedAt', 'files'],
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
    // A Discord user id (snowflake), same convention as /api/v1/layouts?author=.
    author: { type: 'string' },
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
 * `assetKind` is required, not defaulted (#105 decision): the route now
 * covers three structurally different upload shapes, so which one a given
 * request means has to be explicit rather than inferred or assumed.
 * `category` is required only alongside `assetKind: 'furniture'` — checked in
 * `submit.ts` before decode, the same way `resolveUploader` already does
 * manual cross-field validation for `discordUserId` (JSON Schema's
 * conditional keywords would need `if`/`then` here for one extra field,
 * which is more machinery than the one check it replaces).
 */
export const submitCustomAssetQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 60 },
    assetKind: { type: 'string', enum: ['furniture', 'character', 'pet'] },
    category: {
      type: 'string',
      enum: ['desks', 'chairs', 'electronics', 'storage', 'decor', 'misc', 'wall'],
    },
    // Required only for an X-Api-Key-authenticated (bot-originated) upload —
    // see submit.ts. A web upload attributes to the caller's own session and
    // must not supply this.
    discordUserId: { type: 'string', pattern: '^\\d{17,20}$' },
  },
  required: ['name', 'assetKind'],
} as const;
