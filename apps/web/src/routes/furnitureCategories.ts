/**
 * The furniture category list, fetched from the same commit-pinned sidecar
 * `live-office/assets.ts` reads its other build-time-decoded vendor data
 * from (`apps/web/build/liveOfficeAssets.ts`) — generated from
 * `furnitureCategories()` (`@pixel-index/layout-core`), derived from the
 * pinned vendor's real bundled manifests, not a hand-typed list.
 *
 * `AssetFilterBar` and `AssetSubmitPage` both need this; the module-level
 * cached promise means whichever mounts first triggers the one fetch the
 * other reuses, rather than each firing its own.
 */

import { useEffect, useState } from 'react';

const base = `${import.meta.env.BASE_URL}assets/pixel-agents/${__PIXEL_AGENTS_COMMIT__}`;

let cached: Promise<string[]> | null = null;

export function loadFurnitureCategories(): Promise<string[]> {
  cached ??= fetch(`${base}/furniture-categories.json`).then((response) => {
    if (!response.ok) throw new Error(`Could not load furniture-categories.json (${response.status}).`);
    return response.json() as Promise<string[]>;
  });
  return cached;
}

/**
 * `[]` until loaded. A failure degrades to an empty list rather than an
 * error banner — same "the dropdown is a nicety, not the page" spirit
 * `live-office/assets.ts`'s own `loadCustomAssetCatalog()` already applies
 * to a failed fetch, not `useApi`'s full loading/error state machine, which
 * is overkill for populating one `<select>`.
 */
export function useFurnitureCategories(): string[] {
  const [categories, setCategories] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    loadFurnitureCategories()
      .then((loaded) => {
        if (!cancelled) setCategories(loaded);
      })
      .catch((error: unknown) => {
        console.warn('[furniture categories] Could not load furniture-categories.json.', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return categories;
}
