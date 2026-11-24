/**
 * The one rule that turns a posting re-check read into a decision.
 *
 * Pure: counters, one read outcome and a date in; a decision and the next counters out. No database,
 * no clock, no network. The task that performs the read lives in src/tasks/availabilityRecheck.ts.
 *
 * A posting is closed on clear evidence only:
 *   - the page says not found or no longer accepting (CLOSED_BY_PAGE), or
 *   - a SUCCESSFUL, complete read of the source feed did not contain the posting on two reads in a
 *     row (FEED_ABSENT, counted in consecutive_absent_reads).
 * Anything else is "cannot tell" (timeout, server error, rate limit, paywall, login, incomplete feed,
 * a feed record that conflicts with the stored posting). A failed read never counts as absence and
 * never resets the absence count. "Cannot tell" is retried 3 times, one day apart, then the job is
 * archived as not confirmable; the archive also happens at day 10 of the cycle even if retries ran
 * late. Unknown stays unknown: nothing here closes a job on a failed read.
 */

export const ABSENT_READS_TO_CLOSE = 2;
export const CANNOT_TELL_RETRIES = 3;
export const CANNOT_TELL_RETRY_INTERVAL_MS = 24 * 3_600_000;

export type RecheckReadKind = "FEED" | "PAGE" | "NONE";

export type CannotTellReason =
  | "TIMEOUT_OR_NETWORK"
  | "SERVER_ERROR"
  | "RATE_LIMITED"
  | "PAYWALL_OR_LOGIN"
  | "BOT_BLOCKED"
  | "INCOMPLETE_FEED"
  | "FEED_RECORD_CONFLICT"
  | "IDENTITY_CONFLICT"
  | "UNSUPPORTED_SOURCE"
  | "NO_POSTING_LINK";

export type RecheckReadOutcome =
  | { readonly kind: "OPEN" }
  | { readonly kind: "CLOSED_BY_PAGE"; readonly reasonCode: string }
  | { readonly kind: "FEED_ABSENT" }
  | { readonly kind: "CANNOT_TELL"; readonly reason: CannotTellReason };

export interface RecheckCounters {
  readonly consecutiveAbsentReads: number;
  readonly cannotTellAttempts: number;
  /** End of the expired window: when this re-check cycle began. Null before the first read. */
  readonly cycleStartedAt: Date | null;
}

export type RecheckAction =
  | "MARK_OPEN"
  | "MARK_CLOSED"
  | "WAIT_NEXT_READ"
  | "RETRY_LATER"
  | "ARCHIVE_NOT_CONFIRMABLE";

export interface RecheckDecision {
  readonly action: RecheckAction;
  readonly reasonCode: string;
  /** When the next read is due; null when the cycle is over. */
  readonly nextCheckAt: Date | null;
  readonly counters: RecheckCounters;
}

export const EMPTY_RECHECK_COUNTERS: RecheckCounters = {
  consecutiveAbsentReads: 0,
  cannotTellAttempts: 0,
  cycleStartedAt: null,
};

/**
 * @param cycleStartedAt when the expired window ended (job_versions.availability_recheck_at). Used only
 *   when the counters carry no cycle yet.
 */
export function decideRecheck(
  counters: RecheckCounters,
  outcome: RecheckReadOutcome,
  now: Date,
  cycleStartedAt: Date,
): RecheckDecision {
  const cycleStart = counters.cycleStartedAt ?? cycleStartedAt;
  const nextDay = new Date(now.getTime() + CANNOT_TELL_RETRY_INTERVAL_MS);

  if (outcome.kind === "OPEN") {
    return {
      action: "MARK_OPEN",
      reasonCode: "POSTING_CONFIRMED_OPEN",
      nextCheckAt: null,
      counters: { consecutiveAbsentReads: 0, cannotTellAttempts: 0, cycleStartedAt: null },
    };
  }

  if (outcome.kind === "CLOSED_BY_PAGE") {
    return {
      action: "MARK_CLOSED",
      reasonCode: outcome.reasonCode,
      nextCheckAt: null,
      counters: { ...counters, cycleStartedAt: cycleStart },
    };
  }

  if (outcome.kind === "FEED_ABSENT") {
    // A successful read: it can tell, so the cannot-tell run is over; the absence run grows.
    const absent = counters.consecutiveAbsentReads + 1;
    const next: RecheckCounters = { consecutiveAbsentReads: absent, cannotTellAttempts: 0, cycleStartedAt: cycleStart };
    if (absent >= ABSENT_READS_TO_CLOSE) {
      return { action: "MARK_CLOSED", reasonCode: "FEED_READ_ABSENT_TWICE", nextCheckAt: null, counters: next };
    }
    return { action: "WAIT_NEXT_READ", reasonCode: "FEED_READ_ABSENT_ONCE", nextCheckAt: nextDay, counters: next };
  }

  // CANNOT_TELL: the absence count is untouched (a failed read is not a read of the feed).
  const attempts = counters.cannotTellAttempts + 1;
  const next: RecheckCounters = {
    consecutiveAbsentReads: counters.consecutiveAbsentReads,
    cannotTellAttempts: attempts,
    cycleStartedAt: cycleStart,
  };
  // Real attempts only: the job is archived after the retries have all been READ and all failed, never because
  // time passed. A worker backlog therefore cannot turn one infrastructure failure into an archive; each read
  // is queued a day after the previous one, so the counted reads are on separate days.
  const retriesUsed = attempts - 1;
  if (retriesUsed >= CANNOT_TELL_RETRIES) {
    return {
      action: "ARCHIVE_NOT_CONFIRMABLE",
      reasonCode: `CANNOT_TELL_RETRIES_EXHAUSTED:${outcome.reason}`,
      nextCheckAt: null,
      counters: next,
    };
  }
  return {
    action: "RETRY_LATER",
    reasonCode: `CANNOT_TELL:${outcome.reason}`,
    nextCheckAt: nextDay,
    counters: next,
  };
}
