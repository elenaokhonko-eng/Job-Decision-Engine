import { describe, expect, it } from "vitest";

import {
  AFFECTED_HISTORICAL_REPLAY_STATES,
  CANARIES_ONLY_FLAG,
  haveSameNumericCounts,
  isCanariesOnlyMode,
  shouldReplayAffectedHistoricalJobs,
} from "../../scripts/historicalReplayScope.js";

describe("historical replay scope", () => {
  it("includes prequalified jobs in the affected historical cohort", () => {
    expect(AFFECTED_HISTORICAL_REPLAY_STATES).toContain("PREQUALIFIED");
  });

  it("skips replay when the affected cohort is empty", () => {
    expect(shouldReplayAffectedHistoricalJobs([])).toBe(false);
    expect(shouldReplayAffectedHistoricalJobs(["job-1"])).toBe(true);
  });

  it("recognizes an explicit canary-only invocation", () => {
    expect(isCanariesOnlyMode([])).toBe(false);
    expect(isCanariesOnlyMode([CANARIES_ONLY_FLAG])).toBe(true);
  });

  it("detects count changes in either direction", () => {
    expect(haveSameNumericCounts({ gates: 2, queue: 1 }, { gates: 2, queue: 1 })).toBe(true);
    expect(haveSameNumericCounts({ gates: 2 }, { gates: 2, queue: 1 })).toBe(false);
    expect(haveSameNumericCounts({ gates: 2, queue: 1 }, { gates: 2 })).toBe(false);
  });
});
