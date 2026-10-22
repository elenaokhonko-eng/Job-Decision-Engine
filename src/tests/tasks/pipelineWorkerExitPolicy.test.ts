import { describe, expect, it } from "vitest";

import { enforcePipelineWorkerExitPolicy } from "../../tasks/pipelineWorkerExitPolicy.js";

const healthyInput = {
  claimedThisRun: 1,
  completedThisRun: 1,
  failedThisRun: 0,
  deadLetteredThisRun: 0,
  actionableCurrentDeadLetterCount: 0,
  staleHistoricalDeadLetterCount: 0,
  retryWaitCount: 0,
  oldestRetryWaitAgeSeconds: 0,
  activePendingCount: 0,
  oldestActivePendingAgeSeconds: 0,
  failOnRetryWait: false,
  maxRetryWaitCount: 5,
  maxRetryWaitAgeSeconds: 3600,
  maxPendingAgeSeconds: 3600,
  activePendingCountBefore: 0,
  oldestActivePendingAgeSecondsBefore: 0,
  noProgressPendingThreshold: 1,
};

describe("pipeline worker exit policy", () => {
  it("permits a recoverable retry in scheduled-production mode", () => {
    expect(() => enforcePipelineWorkerExitPolicy({
      ...healthyInput,
      failedThisRun: 1,
      retryWaitCount: 1,
      oldestRetryWaitAgeSeconds: 30,
      failOnRetryWait: false,
    })).not.toThrow();
  });

  it("keeps strict retry failure behavior for CI and release validation", () => {
    expect(() => enforcePipelineWorkerExitPolicy({
      ...healthyInput,
      failedThisRun: 1,
      retryWaitCount: 1,
      failOnRetryWait: true,
    })).toThrow("moved 1 task(s) to RETRY_WAIT");
  });

  it("permits healthy bounded progress with an older remaining pending queue", () => {
    expect(() => enforcePipelineWorkerExitPolicy({
      ...healthyInput,
      claimedThisRun: 12,
      completedThisRun: 12,
      activePendingCountBefore: 120,
      activePendingCount: 100,
      oldestActivePendingAgeSecondsBefore: 100000,
      oldestActivePendingAgeSeconds: 99900,
      exitReason: "WALL_CLOCK_BUDGET_REACHED",
    })).not.toThrow();
  });

  it.each([
    { completedThisRun: 0, failedThisRun: 0 },
    { completedThisRun: 1, failedThisRun: 1 },
  ])("keeps the pending-age SLO when bounded work did not complete cleanly", ({ completedThisRun, failedThisRun }) => {
    expect(() => enforcePipelineWorkerExitPolicy({
      ...healthyInput,
      claimedThisRun: 12,
      completedThisRun,
      failedThisRun,
      activePendingCountBefore: 100,
      activePendingCount: 100,
      oldestActivePendingAgeSecondsBefore: 100000,
      oldestActivePendingAgeSeconds: 100000,
      exitReason: "WALL_CLOCK_BUDGET_REACHED",
    })).toThrow("Pending queue age exceeded SLO");
  });

  it("permits inherited stale historical dead letters after they are reconciled", () => {
    expect(() => enforcePipelineWorkerExitPolicy({
      ...healthyInput,
      deadLetteredThisRun: 0,
      actionableCurrentDeadLetterCount: 0,
      staleHistoricalDeadLetterCount: 8,
    })).not.toThrow();
  });

  it("fails for actionable current and newly created dead letters", () => {
    expect(() => enforcePipelineWorkerExitPolicy({
      ...healthyInput,
      actionableCurrentDeadLetterCount: 1,
    })).toThrow("1 actionable current DEAD_LETTER");
    expect(() => enforcePipelineWorkerExitPolicy({
      ...healthyInput,
      deadLetteredThisRun: 1,
    })).toThrow("created 1 DEAD_LETTER");
  });

  it("fails for retry SLO breaches and no forward progress", () => {
    expect(() => enforcePipelineWorkerExitPolicy({
      ...healthyInput,
      retryWaitCount: 6,
    })).toThrow("Retry backlog exceeded SLO");
    expect(() => enforcePipelineWorkerExitPolicy({
      ...healthyInput,
      claimedThisRun: 0,
      activePendingCount: 1,
    })).toThrow("No forward progress");
  });
});
