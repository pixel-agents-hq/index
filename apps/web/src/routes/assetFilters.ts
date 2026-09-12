import type { ListAssetsParams } from '../api/types';

/**
 * Deliberately smaller than `filters.ts`'s layout `Filters`: `GET /api/v1/assets`
 * (services/api's `listCustomAssetsQuerySchema`) supports only `assetKind`,
 * `category`, `source`, `author` and the tag facet filter today — no sort,
 * no free-text search, no numeric ranges. This mirrors exactly what the API
 * can honor rather than building UI for filters it would silently ignore.
 */
export interface AssetFilters {
  /** Furniture/character/pet — built-in and custom assets of every kind share one gallery. */
  assetKind: 'furniture' | 'character' | 'pet' | null;
  /** Furniture-only (#105) — a character/pet row always has a null category. */
  category: string | null;
  /** `'builtin'` / `'custom'` narrows the gallery to one origin; `null` shows both, interleaved. */
  source: 'builtin' | 'custom' | null;
  author: string | null;
  /** Not shown in the filter bar — set by clicking an author name on a card. */
  authorLabel: string | null;
  /**
   * The tag facet filter (services/api's `assets/tags.ts`) — multi-select,
   * OR'd within each facet ("front OR back"), AND'd across the facets that
   * are actually set. `interactable` is binary (has the tag or lacks it), so
   * it's a tri-state (any/yes/no) rather than a multi-select list.
   */
  orientation: string[];
  animation: string[];
  interactable: boolean | null;
}

export const DEFAULT_ASSET_FILTERS: AssetFilters = {
  assetKind: null,
  category: null,
  source: null,
  author: null,
  authorLabel: null,
  orientation: [],
  animation: [],
  interactable: null,
};

function asAssetKind(value: string | null): 'furniture' | 'character' | 'pet' | null {
  return value === 'furniture' || value === 'character' || value === 'pet' ? value : null;
}

function asSource(value: string | null): 'builtin' | 'custom' | null {
  return value === 'builtin' || value === 'custom' ? value : null;
}

function splitCsv(value: string | null): string[] {
  return value
    ? value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
    : [];
}

function asInteractable(value: string | null): boolean | null {
  return value === 'true' ? true : value === 'false' ? false : null;
}

export function assetFiltersFromSearchParams(params: URLSearchParams): AssetFilters {
  return {
    assetKind: asAssetKind(params.get('assetKind')),
    category: params.get('category'),
    source: asSource(params.get('source')),
    author: params.get('author'),
    authorLabel: params.get('authorLabel'),
    orientation: splitCsv(params.get('orientation')),
    animation: splitCsv(params.get('animation')),
    interactable: asInteractable(params.get('interactable')),
  };
}

export function assetFiltersToSearchParams(filters: AssetFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.assetKind) params.set('assetKind', filters.assetKind);
  if (filters.category) params.set('category', filters.category);
  if (filters.source) params.set('source', filters.source);
  if (filters.author) params.set('author', filters.author);
  if (filters.authorLabel) params.set('authorLabel', filters.authorLabel);
  if (filters.orientation.length > 0) params.set('orientation', filters.orientation.join(','));
  if (filters.animation.length > 0) params.set('animation', filters.animation.join(','));
  if (filters.interactable !== null) params.set('interactable', String(filters.interactable));
  return params;
}

export function assetFiltersToApiParams(filters: AssetFilters): ListAssetsParams {
  return {
    ...(filters.assetKind ? { assetKind: filters.assetKind } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.author ? { author: filters.author } : {}),
    ...(filters.orientation.length > 0 ? { orientation: filters.orientation } : {}),
    ...(filters.animation.length > 0 ? { animation: filters.animation } : {}),
    ...(filters.interactable !== null ? { interactable: filters.interactable } : {}),
  };
}

export function isDefaultAssetFilters(filters: AssetFilters): boolean {
  return (
    filters.assetKind === null &&
    filters.category === null &&
    filters.source === null &&
    filters.author === null &&
    filters.orientation.length === 0 &&
    filters.animation.length === 0 &&
    filters.interactable === null
  );
}
