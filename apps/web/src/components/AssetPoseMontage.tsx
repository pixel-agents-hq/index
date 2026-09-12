import { useAssetPoses } from '../api/useAssetPoses';
import { PoseImage } from './AssetPreview';

/**
 * An asset's sprite shown as every pose at once — one cell per orientation
 * or state (a furniture item's on/off states, a character's or pet's walk
 * direction, action, or idle pose), each animating independently when it has
 * more than one frame, labeled with the same text `AssetPreview`'s variant
 * picker shows on the detail page. Wraps to as many rows as it needs;
 * nothing is capped or truncated, since a manifest's orientation/state
 * vocabulary isn't a fixed enum and a cap could silently hide a real state.
 *
 * The visible label matters as much for a character/pet cell as a furniture
 * one: `tags.ts` deliberately keeps orientation out of the filterable `tags`
 * array for character/pet (every one of them has the identical fixed
 * down/up/left/right set, so it narrows nothing as a filter) — this label is
 * where that same information actually reaches a viewer instead.
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
        <div key={pose.key} className="flex flex-col items-center gap-0.5">
          <PoseImage pose={pose} alt={`${alt} — ${pose.label}`} imgClassName={imgClassName} />
          <span className="text-[10px] text-subtle">{pose.label}</span>
        </div>
      ))}
    </div>
  );
}
