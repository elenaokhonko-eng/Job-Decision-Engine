export interface PipelineWorkerExitPolicyInput {
  claimedThisRun: number;
  failedThisRun: number;
  deadLetteredThisRun: number;
  deadLetterCount: number;
  retryWaitCount: number;
  oldestRetryWaitAgeSeconds: number;
  activePendingCount: number;
  oldestActivePendingAgeSeconds: number;
  failOnRetryWait: boolean;
  maxRetryWaitCount: number;
  maxRetryWaitAgeSeconds: number;
  maxPendingAgeSeconds: number;
  noProgressPendingThreshold: number;
}

export function enforcePipelineWorkerExitPolicy(input: PipelineWorkerExitPolicyInput): void {
  if (input.deadLetterCount > 0 || input.deadLetteredThisRun > 0) {
    throw new Error(`Pipeline task worker has ${input.deadLetterCount} DEAD_LETTER task(s).`);
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
  if (input.oldestActivePendingAgeSeconds > input.maxPendingAgeSeconds) {
    throw new Error(
      `Pending queue age exceeded SLO: ${input.oldestActivePendingAgeSeconds}s > ${input.maxPendingAgeSeconds}s.`,
    );
  }
  if (input.claimedThisRun === 0 && input.activePendingCount >= input.noProgressPendingThreshold) {
    throw new Error(
      `No forward progress: ${input.activePendingCount} active PENDING task(s) remain claimable after the worker run.`,
    );
  }
}
