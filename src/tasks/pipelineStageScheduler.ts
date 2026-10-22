export interface PipelineStageRoundPlan<T extends string> {
  taskType: T;
  claimLimit: number;
}

export function planPipelineStageRound<T extends string>(
  taskTypes: readonly T[],
  stageQuantum: number,
  claimedByType: Partial<Record<T, number>>,
  stageLimits: Partial<Record<T, number>>,
  defaultStageLimit: number,
  remainingGlobalTasks: number,
): PipelineStageRoundPlan<T>[] {
  const quantum = Math.max(1, Math.floor(stageQuantum));
  const globalBudget = Math.max(0, Math.floor(remainingGlobalTasks));
  const plans: PipelineStageRoundPlan<T>[] = [];
  if (globalBudget === 0) return plans;

  for (const taskType of taskTypes) {
    const stageLimit = Math.max(1, Math.floor(stageLimits[taskType] ?? defaultStageLimit));
    const remainingForStage = Math.max(0, stageLimit - (claimedByType[taskType] ?? 0));
    const claimLimit = Math.min(quantum, remainingForStage);
    if (claimLimit <= 0) continue;
    plans.push({ taskType, claimLimit });
  }

  return plans;
}
