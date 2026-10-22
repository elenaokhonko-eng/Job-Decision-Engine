import { describe, expect, it } from "vitest";

import { enforcePipelineWorkerExitPolicy } from "../../tasks/pipelineWorkerExitPolicy.js";

const healthyInput = {
  claimedThisRun: 1,
  failedThisRun: 0,
  deadLetteredThisRun: 0,
  actionableDeadLetters: 0,
  staleHistoricalDeadLetters: 0,
  retryWaitCount: 0,
  oldestRetryWaitAgeSeconds: 0,
  activePendingCount: 0,
  oldestActivePendingAgeSeconds: 0,
  failOnRetryWait: false,
  maxRetryWaitCount: 5,
  maxRetryWaitAgeSeconds: 3600,
  maxPendingAgeSeconds: 3600,
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
      activePendingCount: 100,
      oldestActivePendingAgeSeconds: 100000,
      exitReason: "WALL_CLOCK_BUDGET_REACHED",
    })).not.toThrow();
  });

  it("permits bounded progress when only stale historical dead letters remain", () => {
    expect(() => enforcePipelineWorkerExitPolicy({
      ...healthyInput,
      claimedThisRun: 73,
      exitReason: "WALL_CLOCK_BUDGET_REACHED",
      staleHistoricalDeadLetters: 8,
    })).not.toThrow();
  });

  it("fails while actionable current-version dead letters remain", () => {
    expect(() => enforcePipelineWorkerExitPolicy({
      ...healthyInput,
      actionableDeadLetters: 1,
    })).toThrow("1 actionable current DEAD_LETTER");
  });

  it("fails when this run creates a new dead letter", () => {
    expect(() => enforcePipelineWorkerExitPolicy({
      ...healthyInput,
      deadLetteredThisRun: 1,
    })).toThrow("newly dead-lettered 1 task(s) this run");
  });

  it("preserves retry SLO and no-forward-progress protections", () => {
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
