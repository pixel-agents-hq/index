import { useEffect, useState } from 'react';

import { getAssetFrames } from './client';
import type { AssetPose } from './types';

/**
 * Fetches the poses `/api/v1/assets/:id/frames` reports for an asset (a
 * furniture item's on/off + animation groups, a character's or pet's walking
 * directions) — empty while loading, on a fetch failure, or for an asset with
 * no poses of its own. Shared by `AssetPreview` (one pose at a time, with an
 * optional switcher) and `AssetPoseMontage` (all of them at once).
 */
export function useAssetPoses(assetId: string): AssetPose[] {
  const [poses, setPoses] = useState<AssetPose[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    // Resetting on every `assetId` change is the whole point here — without
    // it, switching assets would keep the PREVIOUS asset's poses around until
    // the new fetch resolves. Same reasoning `useApi.ts` documents for its
    // own reset-to-loading.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPoses([]);
    getAssetFrames(assetId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setPoses(response.poses.filter((pose) => pose.frames.length > 0));
      })
      .catch(() => {
        // A missing/broken /frames response is never fatal here — it just
        // means no animation, and callers already fall back to a plain
        // static image when there are no poses. Nothing here is worth
        // surfacing as a page-level error.
        if (controller.signal.aborted) return;
        setPoses([]);
      });
    return () => controller.abort();
  }, [assetId]);

  return poses;
}
