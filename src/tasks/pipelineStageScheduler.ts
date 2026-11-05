export interface PipelineStageRoundPlan<T extends string> {
  taskType: T;
  claimLimit: number;
}

const DOWNSTREAM_FIRST_TASK_TYPES = [
  "ENQUEUE_EXPLANATION",
  "DECIDE_RECOMMENDATION",
  "MATCH_PROFILE_EVIDENCE",
  "ROUTE_LANE",
  "PUBLISH_EMBEDDING",
  "EXTRACT_QUOTED_REQUIREMENTS",
  "APPLY_HARD_GATES",
  "EXTRACT_DETERMINISTIC_REQUIREMENTS",
  "NORMALIZE_OBSERVATION",
  "FETCH_JOB_CONTENT",
] as const;

const TASK_TYPE_PRIORITY = new Map<string, number>(
  DOWNSTREAM_FIRST_TASK_TYPES.map((taskType, index) => [taskType, index]),
);

export function orderPipelineTaskTypesDownstreamFirst<T extends string>(taskTypes: readonly T[]): T[] {
  return taskTypes
    .map((taskType, inputIndex) => ({ taskType, inputIndex }))
    .sort((left, right) => {
      const leftPriority = TASK_TYPE_PRIORITY.get(left.taskType) ?? Number.MAX_SAFE_INTEGER;
      const rightPriority = TASK_TYPE_PRIORITY.get(right.taskType) ?? Number.MAX_SAFE_INTEGER;
      return leftPriority - rightPriority || left.inputIndex - right.inputIndex;
    })
    .map(({ taskType }) => taskType);
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
  if (globalBudget === 0 || taskTypes.length === 0) return plans;

  for (const taskType of orderPipelineTaskTypesDownstreamFirst(taskTypes)) {
    const stageLimit = Math.max(1, Math.floor(stageLimits[taskType] ?? defaultStageLimit));
    const remainingForStage = Math.max(0, stageLimit - (claimedByType[taskType] ?? 0));
    const claimLimit = Math.min(quantum, remainingForStage);
    if (claimLimit <= 0) continue;
    plans.push({ taskType, claimLimit });
  }

  return plans;
}
