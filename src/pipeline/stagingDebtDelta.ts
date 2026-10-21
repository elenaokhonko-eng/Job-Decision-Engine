export interface StagingWorkspaceDebtCounts {
  readonly technicalErrors: number;
  readonly strandedNonterminalJobs: number;
  readonly pipelineRetryWait: number;
  readonly pipelineDeadLetter: number;
}

export function newlyIntroducedStagingDebt(
  before: StagingWorkspaceDebtCounts,
  after: StagingWorkspaceDebtCounts,
): StagingWorkspaceDebtCounts {
  return {
    technicalErrors: Math.max(0, after.technicalErrors - before.technicalErrors),
    strandedNonterminalJobs: Math.max(0, after.strandedNonterminalJobs - before.strandedNonterminalJobs),
    pipelineRetryWait: Math.max(0, after.pipelineRetryWait - before.pipelineRetryWait),
    pipelineDeadLetter: Math.max(0, after.pipelineDeadLetter - before.pipelineDeadLetter),
  };
}
