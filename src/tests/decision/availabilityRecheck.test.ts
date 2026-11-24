import { describe, expect, it } from "vitest";

import {
  ABSENT_READS_TO_CLOSE,
  CANNOT_TELL_RETRIES,
  EMPTY_RECHECK_COUNTERS,
  decideRecheck,
  type RecheckCounters,
  type RecheckReadOutcome,
} from "../../decision/availabilityRecheck.js";

const DAY = 24 * 3_600_000;
const cycleStart = new Date("2026-12-01T00:00:00Z");
const at = (days: number) => new Date(cycleStart.getTime() + days * DAY);

function step(counters: RecheckCounters, outcome: RecheckReadOutcome, days: number) {
  const decision = decideRecheck(counters, outcome, at(days), cycleStart);
  return decision;
}

describe("decideRecheck", () => {
  it("opens the job and clears every counter when the posting is confirmed open", () => {
    const busy: RecheckCounters = { consecutiveAbsentReads: 1, cannotTellAttempts: 2, cycleStartedAt: cycleStart };
    const decision = step(busy, { kind: "OPEN" }, 1);
    expect(decision.action).toBe("MARK_OPEN");
    expect(decision.counters).toEqual(EMPTY_RECHECK_COUNTERS);
    expect(decision.nextCheckAt).toBeNull();
  });

  it("closes at once when the page itself says the posting is gone", () => {
    const decision = step(EMPTY_RECHECK_COUNTERS, { kind: "CLOSED_BY_PAGE", reasonCode: "PAGE_NOT_FOUND" }, 0);
    expect(decision.action).toBe("MARK_CLOSED");
    expect(decision.reasonCode).toBe("PAGE_NOT_FOUND");
  });

  it("does not close on one successful feed read without the posting; it waits a day", () => {
    const decision = step(EMPTY_RECHECK_COUNTERS, { kind: "FEED_ABSENT" }, 0);
    expect(decision.action).toBe("WAIT_NEXT_READ");
    expect(decision.counters.consecutiveAbsentReads).toBe(1);
    expect(decision.nextCheckAt?.getTime()).toBe(at(1).getTime());
  });

  it(`closes on ${ABSENT_READS_TO_CLOSE} successful feed reads in a row without the posting`, () => {
    const first = step(EMPTY_RECHECK_COUNTERS, { kind: "FEED_ABSENT" }, 0);
    const second = step(first.counters, { kind: "FEED_ABSENT" }, 1);
    expect(second.action).toBe("MARK_CLOSED");
    expect(second.counters.consecutiveAbsentReads).toBe(2);
  });

  it("a failed read between two absences neither counts as absence nor resets the run", () => {
    const first = step(EMPTY_RECHECK_COUNTERS, { kind: "FEED_ABSENT" }, 0);
    const failed = step(first.counters, { kind: "CANNOT_TELL", reason: "TIMEOUT_OR_NETWORK" }, 1);
    expect(failed.action).toBe("RETRY_LATER");
    expect(failed.counters.consecutiveAbsentReads).toBe(1);
    const second = step(failed.counters, { kind: "FEED_ABSENT" }, 2);
    expect(second.action).toBe("MARK_CLOSED");
  });

  it("a read that could not tell never closes the job, whatever the reason", () => {
    for (const reason of ["TIMEOUT_OR_NETWORK", "SERVER_ERROR", "RATE_LIMITED", "PAYWALL_OR_LOGIN", "BOT_BLOCKED",
      "INCOMPLETE_FEED", "FEED_RECORD_CONFLICT", "IDENTITY_CONFLICT", "UNSUPPORTED_SOURCE", "NO_POSTING_LINK"] as const) {
      const decision = step(EMPTY_RECHECK_COUNTERS, { kind: "CANNOT_TELL", reason }, 0);
      expect(decision.action, reason).toBe("RETRY_LATER");
      expect(decision.counters.consecutiveAbsentReads, reason).toBe(0);
    }
  });

  it(`retries ${CANNOT_TELL_RETRIES} times one day apart and then archives as not confirmable by day 3 of the cycle`, () => {
    let counters = EMPTY_RECHECK_COUNTERS;
    const actions: string[] = [];
    for (let day = 0; day <= 3; day += 1) {
      const decision = step(counters, { kind: "CANNOT_TELL", reason: "PAYWALL_OR_LOGIN" }, day);
      actions.push(decision.action);
      counters = decision.counters;
      if (decision.action === "RETRY_LATER") expect(decision.nextCheckAt?.getTime()).toBe(at(day + 1).getTime());
    }
    expect(actions).toEqual(["RETRY_LATER", "RETRY_LATER", "RETRY_LATER", "ARCHIVE_NOT_CONFIRMABLE"]);
  });

  it("archives at the day limit even when the retries ran late", () => {
    const late = step({ consecutiveAbsentReads: 0, cannotTellAttempts: 1, cycleStartedAt: cycleStart },
      { kind: "CANNOT_TELL", reason: "SERVER_ERROR" }, 4);
    expect(late.action).toBe("ARCHIVE_NOT_CONFIRMABLE");
    expect(late.reasonCode).toContain("CANNOT_TELL_DAY_LIMIT_REACHED");
  });

  it("a successful feed read ends a cannot-tell run", () => {
    const decision = step({ consecutiveAbsentReads: 0, cannotTellAttempts: 2, cycleStartedAt: cycleStart }, { kind: "FEED_ABSENT" }, 2);
    expect(decision.counters.cannotTellAttempts).toBe(0);
  });
});
