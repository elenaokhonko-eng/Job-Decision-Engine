/**
 * The one rule that says whether a posting is currently open.
 *
 * Pure: evidence and a date in, a state out. Nothing else in the codebase may work this out.
 * The database view `v_job_availability_current` (migration 114) states the same rule in SQL;
 * `availabilityParity.integration.test.ts` runs the same cases through both and fails on any
 * difference. Change one, change both.
 *
 *   CLOSED  : the source says the posting is closed, or its authoritative expiry date has passed.
 *   OPEN    : status OPEN, verified, and the verification window has not run out.
 *   UNKNOWN : everything else, including OPEN whose window has run out. Unknown stays unknown:
 *             it is never turned into CLOSED here.
 */
export type AvailabilityStatus = "OPEN" | "CLOSED" | "UNKNOWN";
export type AvailabilityState = "OPEN" | "CLOSED" | "UNKNOWN";

export interface AvailabilityEvidence {
  status: AvailabilityStatus | null;
  verifiedAt: Date | string | null;
  /** End of the verification window (job_versions.availability_recheck_at). */
  expiresAt: Date | string | null;
  /** Authoritative posting expiry date from the source, when there is one. */
  sourceExpiresAt?: Date | string | null;
}

export interface AvailabilityAssessment {
  state: AvailabilityState;
  /** True only for state OPEN. */
  current: boolean;
  /** The authoritative source expiry date has passed. */
  postingExpired: boolean;
}

function timeOf(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

export function assessAvailability(evidence: AvailabilityEvidence, now: Date): AvailabilityAssessment {
  const nowMs = now.getTime();
  const sourceExpiry = timeOf(evidence.sourceExpiresAt);
  const postingExpired = sourceExpiry !== null && sourceExpiry <= nowMs;
  const verifiedAt = timeOf(evidence.verifiedAt);
  const expiresAt = timeOf(evidence.expiresAt);
  const current = evidence.status === "OPEN"
    && verifiedAt !== null
    && expiresAt !== null
    && expiresAt > nowMs
    && !postingExpired;
  const state: AvailabilityState = postingExpired || evidence.status === "CLOSED"
    ? "CLOSED"
    : current ? "OPEN" : "UNKNOWN";
  return { state, current, postingExpired };
}
