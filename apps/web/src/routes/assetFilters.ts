import type { ListAssetsParams } from '../api/types';

/**
 * Deliberately smaller than `filters.ts`'s layout `Filters`: `GET /api/v1/assets`
 * (services/api's `listCustomAssetsQuerySchema`) supports only `category` and
 * `author` today — no sort, no free-text search, no numeric ranges. This
 * mirrors exactly what the API can honor rather than building UI for filters
 * it would silently ignore.
 */
export interface AssetFilters {
  category: string | null;
  author: string | null;
  /** Not shown in the filter bar — set by clicking an author name on a card. */
  authorLabel: string | null;
}

export const DEFAULT_ASSET_FILTERS: AssetFilters = {
  category: null,
  author: null,
  authorLabel: null,
};

export function assetFiltersFromSearchParams(params: URLSearchParams): AssetFilters {
  return {
    category: params.get('category'),
    author: params.get('author'),
    authorLabel: params.get('authorLabel'),
  };
}

export function assetFiltersToSearchParams(filters: AssetFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.category) params.set('category', filters.category);
  if (filters.author) params.set('author', filters.author);
  if (filters.authorLabel) params.set('authorLabel', filters.authorLabel);
  return params;
}

export function assetFiltersToApiParams(filters: AssetFilters): ListAssetsParams {
  return {
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.author ? { author: filters.author } : {}),
  };
}

export function isDefaultAssetFilters(filters: AssetFilters): boolean {
  return filters.category === null && filters.author === null;
}
