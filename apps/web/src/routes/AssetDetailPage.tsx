import { Link, useParams } from 'react-router-dom';

import { apiUrl, getAsset } from '../api/client';
import { useApi } from '../api/useApi';
import { AuthorLink } from '../components/AuthorLink';
import { ErrorNotice } from '../components/ErrorNotice';

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function AssetDetailPage() {
  // Same reasoning as LayoutDetailPage: App.tsx registers this component
  // only under `assets/:id`, so an absent id is a routing bug.
  const { id } = useParams<{ id: string }>();
  if (id === undefined) throw new Error('AssetDetailPage rendered without an :id param.');

  const assetState = useApi((signal) => getAsset(id, signal), [id]);

  if (assetState.status === 'loading') {
    return <p className="text-muted">Loading…</p>;
  }
  if (assetState.status === 'error') {
    return <ErrorNotice error={assetState.error} />;
  }

  const asset = assetState.data;

  return (
    <article>
      <h1 className="font-display text-2xl text-ink">{asset.name}</h1>
      <p className="mt-1 text-muted">
        by <AuthorLink author={asset.author} /> · published {dateFormatter.format(new Date(asset.createdAt))}
      </p>

      {/*
        Every published custom asset is already in the editor's palette (see
        live-office/assets.ts's catalog merge) — this is just a convenience
        link, not a per-asset loading mode. Not gated the way "Use as a
        starting point" is on the layout detail page: placing furniture,
        unlike publishing a layout, needs no submission capability.
      */}
      <p className="mt-3">
        <Link to="/editor" className="border-2 border-border px-3 py-1.5 text-sm text-ink hover:border-accent">
          Open in editor
        </Link>
      </p>

      <div className="mt-4 inline-block border-2 border-border bg-canvas p-4">
        <img
          src={apiUrl(asset.files.sprite)}
          alt={`${asset.name} sprite`}
          className="mx-auto max-h-48 [image-rendering:pixelated]"
        />
      </div>

      <dl className="mt-8 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-muted">
        <dt>Asset id</dt>
        <dd className="font-mono text-xs">{asset.assetId}</dd>
        <dt>{asset.category ? 'Category' : 'Kind'}</dt>
        <dd>{asset.category ?? asset.assetKind}</dd>
        <dt>Variants</dt>
        <dd>{asset.variantCount}</dd>
        <dt>Last updated</dt>
        <dd>{dateFormatter.format(new Date(asset.updatedAt))}</dd>
      </dl>
    </article>
  );
}
