import { Link, useParams } from 'react-router-dom';

import { apiUrl, getAsset } from '../api/client';
import { useApi } from '../api/useApi';
import { AssetPreview } from '../components/AssetPreview';
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
        {asset.source === 'builtin' ? (
          <>Built-in — bundled with Pixel Agents</>
        ) : (
          <>
            by <AuthorLink author={asset.author} />
          </>
        )}{' '}
        · published {dateFormatter.format(new Date(asset.createdAt))}
      </p>

      {asset.tags.length > 0 && (
        <ul className="m-0 mt-2 flex flex-wrap gap-1.5 p-0">
          {asset.tags.map((tag) => (
            <li
              key={tag}
              className="rounded border border-border px-2 py-0.5 text-xs capitalize text-subtle"
            >
              {tag}
            </li>
          ))}
        </ul>
      )}

      {/*
        #121: a single-asset inspection editor — the general `/editor` loads
        the built-in catalog only (#120), but `?asset=<id>` adds exactly this
        one asset on top of it. Inspection only: publishing and saving are
        unavailable on that route, not merely hidden. Deliberately ungated on
        `asset.source`/`assetKind` — every kind (furniture, character, pet)
        and both sources (custom and built-in) get this link, for symmetry
        and simplicity; a built-in asset is already in the base bundle, so
        it's a harmless no-op there. Unrelated to #102 (pre-publish preview
        rendering quality for `/assets/submit`) — this is post-publish
        inspection of an asset that already exists, not a factor in the
        submit flow.
      */}
      <p className="mt-3 flex flex-wrap gap-2">
        <Link
          to={`/editor?asset=${asset.assetId}`}
          className="border-2 border-border px-3 py-1.5 text-sm text-ink hover:border-accent"
        >
          Open in editor
        </Link>
        {/*
          Built-in assets are already freely available from the
          vendor/pixel-agents repo itself (#119) — a download affordance for
          them here would be redundant, so this is gated the same way the
          "Built-in" badge above is.
        */}
        {asset.source === 'custom' && (
          <a
            href={apiUrl(`/api/v1/assets/${asset.assetId}/download`)}
            download={`${asset.assetId}.zip`}
            className="border-2 border-border px-3 py-1.5 text-sm text-ink hover:border-accent"
          >
            Download
          </a>
        )}
      </p>

      <div className="mt-4 inline-block border-2 border-border bg-canvas p-4">
        <AssetPreview
          assetId={asset.assetId}
          fallbackSrc={apiUrl(asset.files.sprite)}
          alt={`${asset.name} sprite`}
          imgClassName="mx-auto max-h-48 [image-rendering:pixelated]"
          showVariantPicker
        />
      </div>

      <dl className="mt-8 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-muted">
        <dt>Asset id</dt>
        <dd className="font-mono text-xs">{asset.assetId}</dd>
        <dt>{asset.category ? 'Category' : 'Kind'}</dt>
        <dd>{asset.category ?? asset.assetKind}</dd>
        <dt>Last updated</dt>
        <dd>{dateFormatter.format(new Date(asset.updatedAt))}</dd>
      </dl>
    </article>
  );
}
