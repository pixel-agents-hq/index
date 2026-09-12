import { useEffect, useState } from 'react';

import type { AssetPose } from '../api/types';
import { useAssetPoses } from '../api/useAssetPoses';

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
 * One pose's sprite, animated through its own frames on `FRAME_INTERVAL_MS`
 * ticks whenever it has more than one — entirely independent of any other
 * `PoseImage` rendered alongside it, which is what lets `AssetPoseMontage`
 * run several of these at once, each on its own clock.
 *
 * Callers that can switch which pose this renders (a variant picker, or a
 * different pose becoming `poses[0]`) must key this by the pose's identity
 * (e.g. `key={pose.key}`, or `key={`${assetId}:${pose.key}`} where the same
 * key could otherwise collide across assets) — the frame index resets by
 * remounting, not by watching for prop changes.
 */
export function PoseImage({
  pose,
  alt,
  imgClassName = '',
}: {
  pose: AssetPose;
  alt: string;
  imgClassName?: string;
}) {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (pose.frames.length <= 1 || prefersReducedMotion()) return;
    const frameCount = pose.frames.length;
    const timer = setInterval(() => {
      setFrameIndex((index) => (index + 1) % frameCount);
    }, FRAME_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pose]);

  return (
    <img
      src={pose.frames[frameIndex % pose.frames.length]}
      alt={alt}
      className={imgClassName}
      style={pose.mirror ? { transform: 'scaleX(-1)' } : undefined}
    />
  );
}

/**
 * An asset's sprite, showing one pose at a time — the plain representative
 * PNG (`fallbackSrc`) while poses load, and permanently for an asset with
 * none. The fallback is never a dead end: it is the exact same image the
 * API's `/sprite.png` route already serves, so a preview that can't animate
 * still shows something real.
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
  const poses = useAssetPoses(assetId);
  const [poseIndex, setPoseIndex] = useState(0);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPoseIndex(0);
  }, [assetId]);

  const pose: AssetPose | undefined = poses[poseIndex] ?? poses[0];

  return (
    <div>
      {pose ? (
        <PoseImage key={`${assetId}:${pose.key}`} pose={pose} alt={alt} imgClassName={imgClassName} />
      ) : (
        <img src={fallbackSrc} alt={alt} className={imgClassName} />
      )}
      {showVariantPicker && poses.length > 1 && (
        <div className="mt-3 flex flex-wrap justify-center gap-1.5" role="group" aria-label="Variant">
          {poses.map((p, index) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={index === poseIndex}
              onClick={() => setPoseIndex(index)}
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
