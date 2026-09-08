import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import { ApiError, getAuthor, listAssets, listLayouts } from '../api/client';
import type { AssetSummary, LayoutSummary, PublicAuthorResponse } from '../api/types';
import { AssetCard } from '../components/AssetCard';
import { ErrorNotice } from '../components/ErrorNotice';
import { LayoutCard } from '../components/LayoutCard';

const PAGE_SIZE = 24;

export function AuthorPage() {
  const { id } = useParams<{ id: string }>();
  const [profile, setProfile] = useState<PublicAuthorResponse | null>(null);
  const [layouts, setLayouts] = useState<LayoutSummary[] | null>(null);
  const [assets, setAssets] = useState<AssetSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** The current author's request. loadMore() rides on it — see the effect. */
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!id) return;
    // Shared with loadMore() through the ref, so a page fetched for the
    // previous author cannot be appended to this one's list.
    const controller = new AbortController();
    requestRef.current = controller;
    Promise.all([
      getAuthor(id, controller.signal),
      listLayouts({ author: id, limit: PAGE_SIZE }, controller.signal),
      listAssets({ author: id, limit: PAGE_SIZE }, controller.signal),
    ])
      .then(([author, page, assetPage]) => {
        if (controller.signal.aborted) return;
        setProfile(author);
        setLayouts(page.layouts);
        setCursor(page.nextCursor);
        setAssets(assetPage.assets);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof ApiError ? caught : new ApiError(0, 'Something unexpected went wrong.'));
      });
    return () => {
      controller.abort();
    };
  }, [id]);

  function loadMore() {
    if (!id || !cursor) return;
    // Shares the effect's controller, so navigating to another author aborts
    // this page too rather than appending it to the new author's list.
    const signal = requestRef.current?.signal;
    setLoadingMore(true);
    listLayouts({ author: id, limit: PAGE_SIZE, cursor }, signal)
      .then((page) => {
        if (signal?.aborted) return;
        setLayouts((current) => [...(current ?? []), ...page.layouts]);
        setCursor(page.nextCursor);
      })
      .catch((caught: unknown) => {
        if (signal?.aborted) return;
        setError(caught instanceof ApiError ? caught : new ApiError(0, 'Something unexpected went wrong.'));
      })
      .finally(() => {
        if (!signal?.aborted) setLoadingMore(false);
      });
  }

  if (error) return <ErrorNotice error={error} />;
  if (!profile || !layouts) return <p className="text-muted">Loading author…</p>;

  return (
    <div>
      <header className="mb-6 flex items-center gap-4">
        {profile.author.avatarUrl && (
          <img src={profile.author.avatarUrl} alt="" className="h-16 w-16 rounded-full" />
        )}
        <div>
          <h1 className="font-display text-2xl text-ink">{profile.author.displayName}</h1>
          {profile.author.displayName !== profile.author.username && (
            <p className="text-sm text-muted">@{profile.author.username}</p>
          )}
          <p className="text-sm text-muted">
            {profile.publicLayoutCount} public layout{profile.publicLayoutCount === 1 ? '' : 's'}
          </p>
        </div>
      </header>
      <ul className="grid list-none grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-6 p-0">
        {layouts.map((layout) => <li key={layout.slug}><LayoutCard layout={layout} /></li>)}
      </ul>
      {cursor && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          className="mt-6 border-2 border-border px-4 py-2 text-sm text-ink disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}

      {assets && assets.length > 0 && (
        <>
          <h2 className="mt-10 font-display text-xl text-ink">Custom assets</h2>
          <ul className="mt-4 grid list-none grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-6 p-0">
            {assets.map((asset) => <li key={asset.assetId}><AssetCard asset={asset} /></li>)}
          </ul>
        </>
      )}
    </div>
  );
}
