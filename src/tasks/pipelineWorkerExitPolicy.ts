export interface PipelineWorkerExitPolicyInput {
  claimedThisRun: number;
  completedThisRun: number;
  failedThisRun: number;
  exitReason?: "QUEUE_DRAINED" | "MAX_TASKS_REACHED" | "WALL_CLOCK_BUDGET_REACHED" | "STAGE_LIMIT_REACHED";
  deadLetteredThisRun: number;
  actionableCurrentDeadLetterCount: number;
  staleHistoricalDeadLetterCount: number;
  retryWaitCount: number;
  oldestRetryWaitAgeSeconds: number;
  activePendingCountBefore: number;
  /** All active PENDING tasks, including those scheduled for later (available_at in the future). */
  activePendingCount: number;
  /**
   * Active PENDING tasks whose available_at has passed: the only work a run could have claimed.
   * The no-forward-progress rule counts these, so a queue that holds only scheduled work does not fail.
   */
  activeDuePendingCount: number;
  oldestActivePendingAgeSecondsBefore: number;
  oldestActivePendingAgeSeconds: number;
  oldestActivePendingTaskType?: string | null;
  oldestPendingTaskSameRuns?: number;
  pendingAgeTrendRuns?: number;
  failOnRetryWait: boolean;
  maxRetryWaitCount: number;
  maxRetryWaitAgeSeconds: number;
  maxPendingAgeSeconds: number;
  noProgressPendingThreshold: number;
}

export function enforcePipelineWorkerExitPolicy(input: PipelineWorkerExitPolicyInput): void {
  if (input.deadLetteredThisRun > 0) {
    throw new Error(
      `Pipeline task worker created ${input.deadLetteredThisRun} DEAD_LETTER task(s) in this run.`,
    );
  }
  if (input.actionableCurrentDeadLetterCount > 0) {
    throw new Error(
      `Pipeline task worker has ${input.actionableCurrentDeadLetterCount} actionable current DEAD_LETTER task(s).`,
    );
  }
  if (input.failOnRetryWait && input.failedThisRun > 0) {
    throw new Error(
      `Pipeline task worker moved ${input.failedThisRun} task(s) to RETRY_WAIT. See task errors above.`,
    );
  }
  if (input.retryWaitCount > input.maxRetryWaitCount) {
    throw new Error(`Retry backlog exceeded SLO: ${input.retryWaitCount} > ${input.maxRetryWaitCount}.`);
  }
  if (input.oldestRetryWaitAgeSeconds > input.maxRetryWaitAgeSeconds) {
    throw new Error(
      `Retry backlog age exceeded SLO: ${input.oldestRetryWaitAgeSeconds}s > ${input.maxRetryWaitAgeSeconds}s.`,
    );
  }
  // Old pending work is tolerated on bounded runs only when the measured backlog or age improves.
  const pendingBacklogProgress =
    input.activePendingCount < input.activePendingCountBefore
    || input.oldestActivePendingAgeSeconds < input.oldestActivePendingAgeSecondsBefore;
  const boundedProgressExit =
    input.claimedThisRun > 0
    && input.completedThisRun > 0
    && input.failedThisRun === 0
    && pendingBacklogProgress
    && ["MAX_TASKS_REACHED", "WALL_CLOCK_BUDGET_REACHED", "STAGE_LIMIT_REACHED"].includes(input.exitReason || "");
  const oldestPendingTaskStuckAcrossRuns =
    input.oldestActivePendingAgeSeconds > input.maxPendingAgeSeconds
    && (input.oldestPendingTaskSameRuns ?? 0) >= Math.max(1, input.pendingAgeTrendRuns ?? 3);
  if (
    input.oldestActivePendingAgeSeconds > input.maxPendingAgeSeconds
    && (!boundedProgressExit || oldestPendingTaskStuckAcrossRuns)
  ) {
    const oldestStage = input.oldestActivePendingTaskType
      ? ` Oldest pending stage: ${input.oldestActivePendingTaskType}.`
      : "";
    const repeatedOldest = oldestPendingTaskStuckAcrossRuns
      ? ` The same oldest task remained pending for ${input.oldestPendingTaskSameRuns} consecutive runs.`
      : "";
    throw new Error(
      `Pending queue age exceeded SLO: ${input.oldestActivePendingAgeSeconds}s > ${input.maxPendingAgeSeconds}s.${oldestStage}${repeatedOldest}`,
    );
  }
  // Only due work could have been claimed; tasks scheduled for later are not a stall.
  if (input.claimedThisRun === 0 && input.activeDuePendingCount >= input.noProgressPendingThreshold) {
    const scheduledPending = Math.max(0, input.activePendingCount - input.activeDuePendingCount);
    const scheduledNote = scheduledPending > 0 ? ` ${scheduledPending} more are scheduled for later.` : "";
    throw new Error(
      `No forward progress: ${input.activeDuePendingCount} due PENDING task(s) remain claimable after the worker run.${scheduledNote}`,
    );
  }
}
