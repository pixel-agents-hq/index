import { Link } from 'react-router-dom';

import { apiUrl } from '../api/client';
import type { AssetSummary } from '../api/types';
import { AssetPoseMontage } from './AssetPoseMontage';
import { AuthorLink } from './AuthorLink';

export interface AssetCardProps {
  asset: AssetSummary;
  /**
   * Multi-select checkbox — omitted entirely for a built-in asset (#119: not
   * downloadable here, so there is nothing a selection would do for one).
   */
  selected?: boolean;
  onToggleSelect?: (assetId: string) => void;
}

export function AssetCard({ asset, selected, onToggleSelect }: AssetCardProps) {
  return (
    <article className="relative flex flex-col border-2 border-border bg-surface">
      {asset.source === 'custom' && onToggleSelect && (
        <label
          className="absolute right-2 top-2 z-10 flex h-6 w-6 cursor-pointer items-center justify-center border-2 border-border bg-surface"
          onClick={(event) => event.stopPropagation()}
        >
          <span className="sr-only">Select {asset.name} for download</span>
          <input
            type="checkbox"
            checked={selected ?? false}
            onChange={() => onToggleSelect(asset.assetId)}
            className="h-4 w-4"
          />
        </label>
      )}
      <Link
        to={`/assets/${asset.assetId}`}
        className="block bg-canvas p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <AssetPoseMontage
          assetId={asset.assetId}
          fallbackSrc={apiUrl(asset.files.sprite)}
          alt={`${asset.name} sprite`}
          imgClassName="mx-auto max-h-20 [image-rendering:pixelated]"
        />
      </Link>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <h2 className="m-0 font-display text-lg text-ink">
          <Link to={`/assets/${asset.assetId}`} className="hover:text-accent">
            {asset.name}
          </Link>
        </h2>
        {/* Absence of the badge is itself the "community" signal — no badge for source: 'custom'. */}
        {asset.source === 'builtin' && (
          <span className="w-fit border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-subtle">
            Built-in
          </span>
        )}
        <p className="m-0 text-sm text-muted">
          by <AuthorLink author={asset.author} />
        </p>
        <p className="m-0 text-xs text-subtle">
          {/* #105: category is furniture-only — a character/pet card falls back to its kind. */}
          {asset.category ?? asset.assetKind}
        </p>
        {/*
          Real, user-facing classifiers (orientation/static-animated/interactable)
          — replaces the old "N variants" line, a count of internal
          flattened-manifest leaves that told a viewer nothing about the asset
          itself.
        */}
        {asset.tags.length > 0 && (
          <ul className="m-0 flex flex-wrap gap-1 p-0">
            {asset.tags.map((tag) => (
              <li
                key={tag}
                className="rounded border border-border px-1.5 py-0.5 text-[10px] capitalize text-subtle"
              >
                {tag}
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
