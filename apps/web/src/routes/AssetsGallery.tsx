import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { ApiError, listAssets } from '../api/client';
import type { AssetSummary } from '../api/types';
import { AssetCard } from '../components/AssetCard';
import { AssetFilterBar } from '../components/AssetFilterBar';
import { ErrorNotice } from '../components/ErrorNotice';
import { Masonry } from '../components/Masonry';
import {
  assetFiltersFromSearchParams,
  assetFiltersToApiParams,
  assetFiltersToSearchParams,
  isDefaultAssetFilters,
} from './assetFilters';

const PAGE_SIZE = 24;

/** Same shape as `Home.tsx` — see there for why filter changes replace rather than append. */
export function AssetsGallery() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => assetFiltersFromSearchParams(searchParams), [searchParams]);

  const [assets, setAssets] = useState<AssetSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    requestRef.current = controller;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAssets(null);
    setError(null);
    listAssets({ ...assetFiltersToApiParams(filters), limit: PAGE_SIZE }, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setAssets(response.assets);
        setTotal(response.total);
        setCursor(response.nextCursor);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof ApiError ? caught : new ApiError(0, 'Something unexpected went wrong.'));
      });
    return () => {
      controller.abort();
    };
  }, [filters]);

  function loadMore() {
    if (!cursor) return;
    const signal = requestRef.current?.signal;
    setLoadingMore(true);
    listAssets({ ...assetFiltersToApiParams(filters), limit: PAGE_SIZE, cursor }, signal)
      .then((response) => {
        if (signal?.aborted) return;
        setAssets((existing) => [...(existing ?? []), ...response.assets]);
        setCursor(response.nextCursor);
      })
      .catch((caught: unknown) => {
        if (signal?.aborted) return;
        setError(caught instanceof ApiError ? caught : new ApiError(0, 'Something unexpected went wrong.'));
      })
      .finally(() => {
        if (!signal?.aborted) setLoadingMore(false);
      });
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-2xl text-ink">Custom assets</h1>
        <Link to="/assets/submit" className="border-2 border-accent px-3 py-1.5 text-sm text-accent">
          Upload an asset
        </Link>
      </div>
      <AssetFilterBar filters={filters} onChange={(next) => setSearchParams(assetFiltersToSearchParams(next))} />
      {error ? (
        <ErrorNotice error={error} />
      ) : assets === null ? (
        <p className="text-muted">Loading assets…</p>
      ) : assets.length === 0 ? (
        <div className="text-muted">
          {isDefaultAssetFilters(filters) ? (
            <p>No custom assets published yet.</p>
          ) : (
            <>
              <p>No assets match the current filters.</p>
              <button
                type="button"
                onClick={() => setSearchParams(new URLSearchParams())}
                className="mt-2 text-accent underline"
              >
                Clear filters
              </button>
            </>
          )}
        </div>
      ) : (
        <div>
          <p className="mb-4 text-sm text-muted">
            {total} asset{total === 1 ? '' : 's'}
          </p>
          <Masonry
            items={assets}
            keyFor={(asset) => asset.assetId}
            renderItem={(asset) => <AssetCard asset={asset} />}
            className="list-none p-0"
          />
          {cursor && (
            <div className="mt-6 flex justify-center">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="border-2 border-border px-4 py-2 text-sm text-ink hover:border-accent disabled:opacity-50"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
