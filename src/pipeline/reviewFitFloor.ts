import { REVIEW_FIT_FLOOR_SETTING } from "./reviewFitFloorSetting.js";

export class ReviewFitFloorUnsetError extends Error {
  constructor(detail: string) {
    super(`REVIEW_FIT_FLOOR_UNSET: ${detail} See src/pipeline/reviewFitFloorSetting.ts. Nothing falls back to a legacy threshold.`);
    this.name = "ReviewFitFloorUnsetError";
  }
}

export interface ReviewFitFloor {
  readonly version: string;
  /** On the 0..100 scale of the fit measure. */
  readonly minScore: number;
  /** The same floor as the 0..1 fraction the decision policy compares. */
  readonly fraction: number;
}

/**
 * The approved floor, or a throw. A value of 1 or less is refused as well: that is the fraction form of the legacy
 * threshold, which on the 0..100 scale would let nearly every job into Review. This is a unit check, not a threshold.
 */
export function requireReviewFitFloor(): ReviewFitFloor {
  const { version, minScore } = REVIEW_FIT_FLOOR_SETTING;
  if (minScore === null) throw new ReviewFitFloorUnsetError(`no Review fit floor is approved (${version}).`);
  if (!Number.isFinite(minScore) || minScore <= 1 || minScore > 100) {
    throw new ReviewFitFloorUnsetError(`${version} has minScore=${String(minScore)}, which is not on the 0..100 scale.`);
  }
  return { version, minScore, fraction: minScore / 100 };
}
