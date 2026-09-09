import { Link } from 'react-router-dom';

import { apiUrl } from '../api/client';
import type { AssetSummary } from '../api/types';
import { AuthorLink } from './AuthorLink';

export function AssetCard({ asset }: { asset: AssetSummary }) {
  return (
    <article className="flex flex-col border-2 border-border bg-surface">
      <Link
        to={`/assets/${asset.assetId}`}
        className="block bg-canvas p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <img
          src={apiUrl(asset.files.sprite)}
          alt={`${asset.name} sprite`}
          className="mx-auto max-h-32 [image-rendering:pixelated]"
        />
      </Link>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <h2 className="m-0 font-display text-lg text-ink">
          <Link to={`/assets/${asset.assetId}`} className="hover:text-accent">
            {asset.name}
          </Link>
        </h2>
        <p className="m-0 text-sm text-muted">
          by <AuthorLink author={asset.author} />
        </p>
        <p className="m-0 text-xs text-subtle">
          {/* #105: category is furniture-only — a character/pet card falls back to its kind. */}
          {asset.category ?? asset.assetKind} · {asset.variantCount} variant{asset.variantCount === 1 ? '' : 's'}
        </p>
      </div>
    </article>
  );
}
