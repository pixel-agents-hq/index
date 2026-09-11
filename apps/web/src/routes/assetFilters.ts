import type { ListAssetsParams } from '../api/types';

/**
 * Deliberately smaller than `filters.ts`'s layout `Filters`: `GET /api/v1/assets`
 * (services/api's `listCustomAssetsQuerySchema`) supports only `category`,
 * `source` and `author` today — no sort, no free-text search, no numeric
 * ranges. This mirrors exactly what the API can honor rather than building
 * UI for filters it would silently ignore.
 */
export interface AssetFilters {
  category: string | null;
  /** `'builtin'` / `'custom'` narrows the gallery to one origin; `null` shows both, interleaved. */
  source: 'builtin' | 'custom' | null;
  author: string | null;
  /** Not shown in the filter bar — set by clicking an author name on a card. */
  authorLabel: string | null;
}

export const DEFAULT_ASSET_FILTERS: AssetFilters = {
  category: null,
  source: null,
  author: null,
  authorLabel: null,
};

function asSource(value: string | null): 'builtin' | 'custom' | null {
  return value === 'builtin' || value === 'custom' ? value : null;
}

export function assetFiltersFromSearchParams(params: URLSearchParams): AssetFilters {
  return {
    category: params.get('category'),
    source: asSource(params.get('source')),
    author: params.get('author'),
    authorLabel: params.get('authorLabel'),
  };
}

export function assetFiltersToSearchParams(filters: AssetFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.category) params.set('category', filters.category);
  if (filters.source) params.set('source', filters.source);
  if (filters.author) params.set('author', filters.author);
  if (filters.authorLabel) params.set('authorLabel', filters.authorLabel);
  return params;
}

export function assetFiltersToApiParams(filters: AssetFilters): ListAssetsParams {
  return {
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.author ? { author: filters.author } : {}),
  };
}

export function isDefaultAssetFilters(filters: AssetFilters): boolean {
  return filters.category === null && filters.source === null && filters.author === null;
}
