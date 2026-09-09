/** DB rows -> the public JSON shape, mirroring `layouts/serialize.ts`'s pattern. */

import type * as schema from '../db/schema.js';
import type { PublicAuthor } from '../layouts/serialize.js';

export interface PublicCustomAssetSummary {
  assetId: string;
  assetKind: schema.CustomAsset['assetKind'];
  name: string;
  /** Furniture only (#105) — null for characters and pets. */
  category: string | null;
  author: PublicAuthor;
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
    author: assetAuthor(author),
    variantCount: (asset.manifest as unknown[]).length,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
    files: files(asset.assetId),
  };
}

export function toDetail(asset: schema.CustomAsset, author: schema.User | null): PublicCustomAssetDetail {
  return { ...toSummary(asset, author), manifest: asset.manifest };
}
