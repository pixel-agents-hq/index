/**
 * The synthetic user that owns seed layouts, created by migration 0002.
 *
 * Fixed rather than looked up so #18's seeder and any future tooling can
 * reference it without a query, and so it is identical on every install.
 */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * The synthetic user that authors synced built-in Pixel Agents assets
 * (`custom_assets.source = 'builtin'`), created by migration 0016. Kept
 * distinct from `SYSTEM_USER_ID` — see that migration's comment for why.
 */
export const PIXEL_AGENTS_SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000002';

/** Visibility states that are absent from every public read path. */
export const NON_PUBLIC_VISIBILITIES = ['hidden', 'deleted'] as const;
