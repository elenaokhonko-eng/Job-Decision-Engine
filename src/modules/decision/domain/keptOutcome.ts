/**
 * "A re-run never clears a result" (owner decision).
 *
 * A job whose profile match is not current is waiting for a re-match. It keeps its stored score and outcome: an old
 * score never makes a new decision and never sends a job to AI. Only a fact that does not depend on the score is
 * still written, and it can only lower the stored result.
 */

export type KeptEligibility = "ELIGIBLE" | "VERIFY" | "INELIGIBLE";
export type KeptOutcome = "PRIORITY" | "REVIEW" | "TRACK" | "SKIP";

export interface KeptResult {
  readonly eligibility: KeptEligibility;
  readonly outcome: KeptOutcome;
}

/** Trace note of a decision whose score and coverage are the stored ones, not computed by it. */
export const STORED_SCORE_CARRIED_NOTE = "stored_score_carried";
/** Trace note of a decision that kept the stored outcome because the job waits for a re-match. */
export const AWAITING_REMATCH_NOTE = "awaiting_rematch";
/** A job may wait for a re-match this long before the must-be-zero check `awaiting_rematch_over_limit` flags it. */
export const AWAITING_REMATCH_LIMIT_DAYS = 7;

export interface KeptOutcomeFacts {
  readonly gateDecision: "PASS" | "NEEDS_VERIFICATION" | "HARD_REJECT" | null;
  /** No active lane matches the posting (routing disposition POLICY_NO_MATCH). */
  readonly noMatchingLane: boolean;
  readonly careerTrackCap: "REVIEW" | "SKIP" | null;
  /**
   * BELOW_FLOOR_REJECT and BELOW_FLOOR_HOLD: pay below the owner's floor, with the disposition she set.
   * UNVERIFIED: the posting's pay cannot be confirmed (a fact needing verification).
   */
  readonly pay: "BELOW_FLOOR_REJECT" | "BELOW_FLOOR_HOLD" | "UNVERIFIED" | null;
  /** A material readiness check is BLOCKED, for example the posting is closed. */
  readonly readinessBlocked: boolean;
}

export interface KeptOutcomeResult extends KeptResult {
  /** The facts that changed the stored result; empty when it is unchanged. */
  readonly overrides: readonly string[];
}

const RANK: Readonly<Record<KeptOutcome, number>> = { PRIORITY: 3, REVIEW: 2, TRACK: 1, SKIP: 0 };

/** Applies the score-independent facts to a stored result. Nothing here raises an outcome or an eligibility. */
export function keepStoredOutcome(stored: KeptResult, facts: KeptOutcomeFacts): KeptOutcomeResult {
  let { eligibility, outcome } = stored;
  const overrides: string[] = [];
  const cap = (limit: KeptOutcome, code: string): void => {
    if (RANK[outcome] <= RANK[limit]) return;
    outcome = limit;
    overrides.push(code);
  };
  const reject = (code: string): void => {
    if (eligibility === "INELIGIBLE" && outcome === "SKIP") return;
    eligibility = "INELIGIBLE";
    outcome = "SKIP";
    overrides.push(code);
  };

  if (facts.gateDecision === "NEEDS_VERIFICATION") {
    if (eligibility === "ELIGIBLE") {
      eligibility = "VERIFY";
      overrides.push("needs_verification");
    }
    cap("REVIEW", "needs_verification_review_cap");
  }
  if (facts.pay === "UNVERIFIED") cap("REVIEW", "pay_needs_verification");
  if (facts.careerTrackCap) cap(facts.careerTrackCap, "career_track_cap");
  if (facts.noMatchingLane) cap("SKIP", "no_matching_lane");
  if (facts.pay === "BELOW_FLOOR_HOLD") cap("TRACK", "pay_below_floor");
  if (facts.pay === "BELOW_FLOOR_REJECT") reject("pay_below_floor");
  if (facts.gateDecision === "HARD_REJECT") reject("hard_reject");
  if (facts.readinessBlocked) reject("readiness_blocked");

  return { eligibility, outcome, overrides };
}
