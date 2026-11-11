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
  activeDuePendingCount: 0,
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

  it.each([
    {
      progressMetric: "pending count",
      activePendingCountBefore: 120,
      activePendingCount: 100,
      oldestActivePendingAgeSecondsBefore: 100000,
      oldestActivePendingAgeSeconds: 100000,
    },
    {
      progressMetric: "oldest pending age",
      activePendingCountBefore: 100,
      activePendingCount: 100,
      oldestActivePendingAgeSecondsBefore: 100000,
      oldestActivePendingAgeSeconds: 99900,
    },
  ])("permits a clean bounded run when $progressMetric measurably improves", ({
    activePendingCountBefore,
    activePendingCount,
    oldestActivePendingAgeSecondsBefore,
    oldestActivePendingAgeSeconds,
  }) => {
    expect(() => enforcePipelineWorkerExitPolicy({
      ...healthyInput,
      claimedThisRun: 12,
      completedThisRun: 12,
      activePendingCountBefore,
      activePendingCount,
      oldestActivePendingAgeSecondsBefore,
      oldestActivePendingAgeSeconds,
      exitReason: "WALL_CLOCK_BUDGET_REACHED",
    })).not.toThrow();
  });

  it("keeps the age SLO active when the same oldest task survives the configured number of runs", () => {
    expect(() => enforcePipelineWorkerExitPolicy({
      ...healthyInput,
      claimedThisRun: 12,
      completedThisRun: 12,
      activePendingCountBefore: 100,
      activePendingCount: 90,
      oldestActivePendingAgeSecondsBefore: 100000,
      oldestActivePendingAgeSeconds: 101000,
      oldestActivePendingTaskType: "DECIDE_RECOMMENDATION",
      oldestPendingTaskSameRuns: 3,
      pendingAgeTrendRuns: 3,
      exitReason: "WALL_CLOCK_BUDGET_REACHED",
    })).toThrow("Oldest pending stage: DECIDE_RECOMMENDATION");
  });

  it("tolerates an old queue while the repeated-oldest-task trend is still below its threshold", () => {
    expect(() => enforcePipelineWorkerExitPolicy({
      ...healthyInput,
      claimedThisRun: 12,
      completedThisRun: 12,
      activePendingCountBefore: 100,
      activePendingCount: 90,
      oldestActivePendingAgeSecondsBefore: 100000,
      oldestActivePendingAgeSeconds: 101000,
      oldestActivePendingTaskType: "DECIDE_RECOMMENDATION",
      oldestPendingTaskSameRuns: 2,
      pendingAgeTrendRuns: 3,
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
      activeDuePendingCount: 1,
    })).toThrow("No forward progress");
  });

  it("does not report missing progress when every remaining PENDING task is scheduled for later", () => {
    // Nothing was due, so a run that claimed nothing has not stalled.
    expect(() => enforcePipelineWorkerExitPolicy({
      ...healthyInput,
      claimedThisRun: 0,
      completedThisRun: 0,
      exitReason: "QUEUE_DRAINED",
      activePendingCountBefore: 4,
      activePendingCount: 4,
      activeDuePendingCount: 0,
    })).not.toThrow();
  });

  it("still fails when due work stays unclaimed next to scheduled work", () => {
    expect(() => enforcePipelineWorkerExitPolicy({
      ...healthyInput,
      claimedThisRun: 0,
      completedThisRun: 0,
      exitReason: "QUEUE_DRAINED",
      activePendingCountBefore: 4,
      activePendingCount: 4,
      activeDuePendingCount: 1,
    })).toThrow("No forward progress: 1 due PENDING task(s) remain claimable after the worker run. 3 more are scheduled for later.");
  });
});
