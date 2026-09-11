import { useEffect, useState } from 'react';

import { getAssetFrames } from '../api/client';
import type { AssetPose } from '../api/types';

/** Matches upstream's own furniture screen-flicker cadence (`FURNITURE_ANIM_INTERVAL_SEC` in the vendored engine). */
const FRAME_INTERVAL_MS = 200;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    // matchMedia can throw in an unusual test/embed environment — motion is
    // the enhancement here, so failing that check open (assume motion is
    // fine) is the safer default than breaking the preview outright.
    return false;
  }
}

/**
 * An asset's sprite, animated through whatever poses `/api/v1/assets/:id/frames`
 * reports (a furniture item's on/off + animation groups, a character's or
 * pet's walking directions) — falling back to the plain representative PNG
 * (`fallbackSrc`) while that loads, and permanently for an asset with no
 * poses of its own or if the request fails. The fallback is never a dead
 * end: it is the exact same image the API's `/sprite.png` route already
 * serves, so a preview that can't animate still shows something real.
 */
export function AssetPreview({
  assetId,
  fallbackSrc,
  alt,
  imgClassName = '',
  showVariantPicker = false,
}: {
  assetId: string;
  fallbackSrc: string;
  alt: string;
  imgClassName?: string;
  /** Detail-page mode: a row of buttons lets a visitor switch which pose is showing. */
  showVariantPicker?: boolean;
}) {
  const [poses, setPoses] = useState<AssetPose[]>([]);
  const [poseIndex, setPoseIndex] = useState(0);
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    // Resetting on every `assetId` change is the whole point here — without
    // it, switching assets would keep animating the PREVIOUS asset's poses
    // until the new fetch resolves. Same reasoning `useApi.ts` documents for
    // its own reset-to-loading.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPoses([]);
    setPoseIndex(0);
    setFrameIndex(0);
    getAssetFrames(assetId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setPoses(response.poses.filter((pose) => pose.frames.length > 0));
      })
      .catch(() => {
        // A missing/broken /frames response is never fatal to this preview —
        // it just means no animation, and the fallback image below already
        // covers that. Nothing here is worth surfacing as a page-level error.
        if (controller.signal.aborted) return;
        setPoses([]);
      });
    return () => controller.abort();
  }, [assetId]);

  const pose: AssetPose | undefined = poses[poseIndex] ?? poses[0];

  useEffect(() => {
    if (!pose || pose.frames.length <= 1 || prefersReducedMotion()) return;
    const frameCount = pose.frames.length;
    const timer = setInterval(() => {
      setFrameIndex((index) => (index + 1) % frameCount);
    }, FRAME_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pose]);

  const src = pose ? (pose.frames[frameIndex % pose.frames.length] ?? fallbackSrc) : fallbackSrc;

  return (
    <div>
      <img
        src={src}
        alt={alt}
        className={imgClassName}
        style={pose?.mirror ? { transform: 'scaleX(-1)' } : undefined}
      />
      {showVariantPicker && poses.length > 1 && (
        <div className="mt-3 flex flex-wrap justify-center gap-1.5" role="group" aria-label="Variant">
          {poses.map((p, index) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={index === poseIndex}
              onClick={() => {
                setPoseIndex(index);
                setFrameIndex(0);
              }}
              className={`border-2 px-2 py-1 text-xs ${
                index === poseIndex
                  ? 'border-accent bg-accent text-accent-solid-ink'
                  : 'border-border text-muted hover:border-accent'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
