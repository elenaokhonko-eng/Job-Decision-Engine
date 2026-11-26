/**
 * THE REVIEW FIT FLOOR. One named, versioned setting, changed only by a reviewed commit (never an environment variable).
 *
 * Owner decision (26 November): top-K (`topk_capability_semantic_v1`) is the fit measure, and the fit score decides entry to
 * Review as a floor. It is not the ranking.
 *
 * `minScore` is DELIBERATELY UNSET (null): the owner has not approved a value. While it is null the matcher, the decider
 * and the task worker script throw ReviewFitFloorUnsetError. Nothing falls back to the legacy 0.5 threshold or legacy score.
 *
 * To set it:
 *  1. `minScore` is on the scale of the measure, 0..100 (not a 0..1 fraction). It is compared with the stored requirement
 *     score, which is the fit score AFTER the role-shape downranks.
 *  2. Change `version` in the same commit, now and on every later change of the value: it is part of DECIDER_VERSION, so
 *     existing jobs are re-decided.
 *  3. Before setting it, decide the PRIORITY cut-off (`outcome_priority_thresholds` in src/policy/decisionPolicy.ts), which
 *     is still a legacy-scale number.
 */
export const REVIEW_FIT_FLOOR_SETTING: {
  readonly version: string;
  readonly minScore: number | null;
} = {
  version: "review_fit_floor_v1",
  minScore: null,
};
