import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { ApiError, apiUrl, listAssets } from '../api/client';
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

  // Local, transient state (#119) — no existing selection pattern to extend
  // in this app, and a selection made for one bulk download is naturally
  // one-off, so it resets whenever the underlying asset list does rather
  // than surviving a filter change or reload.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    requestRef.current = controller;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAssets(null);
    setError(null);
    setSelected(new Set());
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

  function toggleSelect(assetId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-2xl text-ink">Assets</h1>
        <Link to="/assets/submit" className="border-2 border-accent px-3 py-1.5 text-sm text-accent">
          Upload an asset
        </Link>
      </div>
      <AssetFilterBar filters={filters} onChange={(next) => setSearchParams(assetFiltersToSearchParams(next))} />
      {selected.size > 0 && (
        <div className="mb-4 flex items-center justify-between border-2 border-accent bg-surface px-3 py-2">
          <p className="m-0 text-sm text-ink">
            {selected.size} asset{selected.size === 1 ? '' : 's'} selected
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="px-2 py-1 text-sm text-muted hover:text-ink"
            >
              Clear
            </button>
            {/*
              A plain GET link, same as every other download affordance in
              this app (LayoutJsonPanel.tsx, AssetDetailPage.tsx) — the
              browser handles the download natively via content-disposition,
              no fetch/blob needed here either.
            */}
            <a
              href={apiUrl(`/api/v1/assets/download?ids=${[...selected].join(',')}`)}
              download="pixel-index-assets.zip"
              className="border-2 border-accent px-3 py-1.5 text-sm text-accent hover:bg-accent hover:text-accent-solid-ink"
            >
              Download selected
            </a>
          </div>
        </div>
      )}
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
            renderItem={(asset) => (
              <AssetCard asset={asset} selected={selected.has(asset.assetId)} onToggleSelect={toggleSelect} />
            )}
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
