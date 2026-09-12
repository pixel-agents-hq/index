/** DB rows -> the public JSON shape, mirroring `layouts/serialize.ts`'s pattern. */

import type * as schema from '../db/schema.js';
import type { PublicAuthor } from '../layouts/serialize.js';

export interface PublicCustomAssetSummary {
  assetId: string;
  assetKind: schema.CustomAsset['assetKind'];
  name: string;
  /** Furniture only (#105) — null for characters and pets. */
  category: string | null;
  /** `'builtin'` for the bundled Pixel Agents catalog synced by `builtinSync.ts`, `'custom'` for an upload. */
  source: schema.CustomAsset['source'];
  author: PublicAuthor;
  /**
   * Real, user-facing classifiers (`assets/tags.ts`) — orientation, static/
   * animated, interactable. The primary descriptor a gallery card shows now;
   * see `variantCount`'s own doc comment for why that field stays but is no
   * longer it.
   */
  tags: string[];
  /**
   * A count of internal flattened-manifest leaves (#101) — an
   * implementation-pipeline artifact, not a meaningful user-facing property
   * (one furniture item is one asset to a viewer, regardless of how many
   * rotation/state/animation leaves it decodes into). Kept in the public API
   * for backward compatibility rather than removed outright; `tags` above is
   * the primary classifier `AssetCard`/`AssetDetailPage` now lead with.
   */
  variantCount: number;
  createdAt: string;
  updatedAt: string;
  files: {
    sprite: string;
  };
}

export interface PublicCustomAssetDetail extends PublicCustomAssetSummary {
  manifest: unknown;
}

/** Same shape `publicAuthor()` (layouts/serialize.ts) builds — a custom asset always has a real author, never a legacy display-only credit. */
export function assetAuthor(author: schema.User | null): PublicAuthor {
  const username = author?.username ?? 'unknown';
  return {
    discordId: author?.discordId ?? null,
    username,
    displayName: author?.guildNickname ?? author?.globalName ?? username,
    avatarUrl: author?.avatarUrl ?? null,
  };
}

function files(assetId: string): PublicCustomAssetSummary['files'] {
  return { sprite: `/api/v1/assets/${assetId}/sprite.png` };
}

export function toSummary(asset: schema.CustomAsset, author: schema.User | null): PublicCustomAssetSummary {
  return {
    assetId: asset.assetId,
    assetKind: asset.assetKind,
    name: asset.name,
    category: asset.category,
    source: asset.source,
    author: assetAuthor(author),
    tags: asset.tags,
    variantCount: (asset.manifest as unknown[]).length,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
    files: files(asset.assetId),
  };
}

export function toDetail(asset: schema.CustomAsset, author: schema.User | null): PublicCustomAssetDetail {
  return { ...toSummary(asset, author), manifest: asset.manifest };
}
