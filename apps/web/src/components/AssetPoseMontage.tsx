import { useAssetPoses } from '../api/useAssetPoses';
import { PoseImage } from './AssetPreview';

/**
 * An asset's sprite shown as every pose at once — one cell per orientation
 * or state (a furniture item's on/off states, a character's or pet's walk
 * directions), each animating independently when it has more than one
 * frame. Wraps to as many rows as it needs; nothing is capped or truncated,
 * since a manifest's orientation/state vocabulary isn't a fixed enum and a
 * cap could silently hide a real state.
 *
 * Falls back to the plain representative PNG (`fallbackSrc`) while poses
 * load, and permanently for an asset with none — same convention as
 * `AssetPreview`, which this shares its pose-fetching and per-pose
 * frame-cycling with.
 */
export function AssetPoseMontage({
  assetId,
  fallbackSrc,
  alt,
  imgClassName = '',
}: {
  assetId: string;
  fallbackSrc: string;
  alt: string;
  imgClassName?: string;
}) {
  const poses = useAssetPoses(assetId);

  if (poses.length === 0) {
    return <img src={fallbackSrc} alt={alt} className={imgClassName} />;
  }

  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="States">
      {poses.map((pose) => (
        <PoseImage key={pose.key} pose={pose} alt={`${alt} — ${pose.label}`} imgClassName={imgClassName} />
      ))}
    </div>
  );
}
