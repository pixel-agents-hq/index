import {
  type AssetFilters,
  DEFAULT_ASSET_FILTERS,
  isDefaultAssetFilters,
} from '../routes/assetFilters';

const CATEGORIES = ['desks', 'chairs', 'electronics', 'storage', 'decor', 'misc', 'wall'];

export function AssetFilterBar({
  filters,
  onChange,
}: {
  filters: AssetFilters;
  onChange: (next: AssetFilters) => void;
}) {
  const selectClass = 'border border-border bg-canvas px-2 py-1.5 text-ink';

  return (
    <div className="mb-6 flex flex-col gap-4 border-2 border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-sm text-muted">
          Category
          <select
            value={filters.category ?? ''}
            onChange={(event) => onChange({ ...filters, category: event.target.value || null })}
            className={selectClass}
          >
            <option value="">Any</option>
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
      </div>

      {filters.author && (
        <p className="text-sm text-muted">
          Filtered to author: <strong className="text-ink">{filters.authorLabel ?? filters.author}</strong>
        </p>
      )}

      {!isDefaultAssetFilters(filters) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <button
            type="button"
            onClick={() => onChange(DEFAULT_ASSET_FILTERS)}
            className="ml-auto border border-border px-2 py-1 text-xs text-muted hover:border-accent"
          >
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}
