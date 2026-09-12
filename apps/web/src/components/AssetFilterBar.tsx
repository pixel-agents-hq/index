import {
  type AssetFilters,
  DEFAULT_ASSET_FILTERS,
  isDefaultAssetFilters,
} from '../routes/assetFilters';
import { useFurnitureCategories } from '../routes/furnitureCategories';

/**
 * The fixed vocabularies `services/api/src/assets/tags.ts` computes tags
 * from — not fetched from the API (unlike `useFurnitureCategories`, which
 * varies by what's actually installed): this vocabulary is a fixed part of
 * the manifest format itself (`docs/external-assets.md`'s "Member
 * orientation values"), so it never needs to grow at runtime the way the
 * category list does.
 */
const ORIENTATION_TAGS = ['front', 'back', 'left', 'right', 'side'] as const;
const ANIMATION_TAGS = ['static', 'animated'] as const;

/** Same multi-select toggle-button convention as `FilterBar.tsx`'s tag picker. */
function TagToggleButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded border px-2 py-1 text-xs capitalize ${
        active ? 'border-accent bg-accent-soft text-accent-strong' : 'border-border text-muted hover:border-accent'
      }`}
    >
      {label}
    </button>
  );
}

export function AssetFilterBar({
  filters,
  onChange,
}: {
  filters: AssetFilters;
  onChange: (next: AssetFilters) => void;
}) {
  const categories = useFurnitureCategories();
  const selectClass = 'border border-border bg-canvas px-2 py-1.5 text-ink';

  function toggleOrientation(tag: string) {
    const next = filters.orientation.includes(tag)
      ? filters.orientation.filter((t) => t !== tag)
      : [...filters.orientation, tag];
    onChange({ ...filters, orientation: next });
  }

  function toggleAnimation(tag: string) {
    const next = filters.animation.includes(tag)
      ? filters.animation.filter((t) => t !== tag)
      : [...filters.animation, tag];
    onChange({ ...filters, animation: next });
  }

  return (
    <div className="mb-6 flex flex-col gap-4 border-2 border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-sm text-muted">
          Kind
          <select
            value={filters.assetKind ?? ''}
            onChange={(event) =>
              onChange({ ...filters, assetKind: (event.target.value || null) as AssetFilters['assetKind'] })
            }
            className={selectClass}
          >
            <option value="">Any</option>
            <option value="furniture">Furniture</option>
            <option value="character">Character</option>
            <option value="pet">Pet</option>
          </select>
        </label>

        <label className="flex items-center gap-1.5 text-sm text-muted">
          Category
          <select
            value={filters.category ?? ''}
            onChange={(event) => onChange({ ...filters, category: event.target.value || null })}
            className={selectClass}
          >
            <option value="">Any</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 text-sm text-muted">
          Source
          <select
            value={filters.source ?? ''}
            onChange={(event) =>
              onChange({ ...filters, source: (event.target.value || null) as AssetFilters['source'] })
            }
            className={selectClass}
          >
            <option value="">Any</option>
            <option value="builtin">Built-in</option>
            <option value="custom">Community</option>
          </select>
        </label>

        <label className="flex items-center gap-1.5 text-sm text-muted">
          Interactable
          <select
            value={filters.interactable === null ? '' : String(filters.interactable)}
            onChange={(event) =>
              onChange({
                ...filters,
                interactable: event.target.value === '' ? null : event.target.value === 'true',
              })
            }
            className={selectClass}
          >
            <option value="">Any</option>
            <option value="true">Interactable</option>
            <option value="false">Not interactable</option>
          </select>
        </label>
      </div>

      <fieldset className="flex flex-wrap items-center gap-1.5">
        <legend className="mb-1 w-full text-sm text-muted sm:w-auto sm:mb-0 sm:mr-1">Orientation</legend>
        {ORIENTATION_TAGS.map((tag) => (
          <TagToggleButton
            key={tag}
            label={tag}
            active={filters.orientation.includes(tag)}
            onClick={() => toggleOrientation(tag)}
          />
        ))}
      </fieldset>

      <fieldset className="flex flex-wrap items-center gap-1.5">
        <legend className="mb-1 w-full text-sm text-muted sm:w-auto sm:mb-0 sm:mr-1">Animation</legend>
        {ANIMATION_TAGS.map((tag) => (
          <TagToggleButton
            key={tag}
            label={tag}
            active={filters.animation.includes(tag)}
            onClick={() => toggleAnimation(tag)}
          />
        ))}
      </fieldset>

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
