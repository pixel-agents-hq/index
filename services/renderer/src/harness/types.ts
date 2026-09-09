/**
 * The vocabulary the vendor-update gate (#26) reasons in.
 *
 * The distinction that matters most here is between an outcome that is
 * *deterministic* (this layout is genuinely incompatible with this pin) and
 * one that is *circumstantial* (a browser died, a dev server did not boot, the
 * API was down). Conflating them is how a cron PR ends up red for reasons
 * nobody can act on, which is how people learn to ignore it.
 */

import type { UpstreamPin, ValidationIssue } from '@pixel-index/layout-core';

import type { RenderCustomAsset } from '../render.js';

/** A layout as the gate sees it, whatever it was sourced from. */
export interface HarnessLayout {
  slug: string;
  layout: unknown;
  /**
   * Custom furniture/character/pet this layout needs to prove renders (#105)
   * — the same shape `services/api` embeds in a real `/render` request. Seed
   * layouts opt in via a sibling `custom-assets.json`; the live index never
   * supplies this (a real render request already carries it separately, and
   * the gate isn't re-deriving `customAssetsForLayout` here).
   */
  customAssets?: RenderCustomAsset[];
}

export type LayoutOutcome =
  /** Rendered. `pngSha256` lets the diff report *visual* change, not just failure. */
  | { status: 'ok'; pngSha256: string; bytes: number; retried?: boolean }
  /**
   * Rejected by layout-core before a browser was involved. Always deterministic:
   * a furniture id either exists in the pinned catalog or it does not.
   */
  | { status: 'invalid'; issues: ValidationIssue[] }
  /**
   * Validated, then failed to draw. Deterministic *enough* to report — it
   * survived a retry — but weaker evidence than `invalid`, so the report says
   * which kind it was rather than flattening both into "broken".
   */
  | { status: 'render_failed'; kind: 'timeout' | 'error'; message: string };

export interface PinRun {
  /** Which upstream this run measured against. */
  pin: UpstreamPin;
  /** Where the layouts came from, for the report's provenance line. */
  source: string;
  outcomes: Record<string, LayoutOutcome>;
  startedAt: string;
  finishedAt: string;
}

/**
 * A run that never produced outcomes because the environment failed — the dev
 * server would not boot, the export could not be fetched. Modelled explicitly
 * rather than as an empty `PinRun`, because "nothing broke" and "we could not
 * tell" must never render the same way.
 */
export class HarnessInfraError extends Error {
  // `cause` is Error's own optional property, so this shadows it deliberately
  // (noImplicitOverride is what makes that explicit rather than accidental).
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'HarnessInfraError';
  }
}

export type RegressionKind = 'invalid' | 'render_failed';

export interface Regression {
  slug: string;
  kind: RegressionKind;
  /** Human-readable "why", already truncated for a PR body. */
  detail: string;
}

export type Tier =
  /** Nothing that passed before fails now. */
  | 'pass'
  /** A minority of layouts regressed. A human decides whether to moderate them or accept. */
  | 'regressions'
  /** Enough regressed that the update itself is the problem, not the layouts. */
  | 'systemic';

export interface Verdict {
  tier: Tier;
  regressions: Regression[];
  /** Rendered fine on both pins but produced different pixels. Informational. */
  visuallyChanged: string[];
  /** Broken on both pins — pre-existing, never counted against this update. */
  alreadyBroken: string[];
  /** How many layouts were comparable at all (present in both runs). */
  comparable: number;
}
