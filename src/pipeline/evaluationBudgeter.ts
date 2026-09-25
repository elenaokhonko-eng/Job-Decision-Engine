export interface EvaluationBudgetCandidate {
  id: string;
  lane: string;
  priorityScore: number;
  createdAt: string | Date;
  wasDeferredByBudget?: boolean;
}

export interface EvaluationBudgetDecision {
  selected: EvaluationBudgetCandidate[];
  deferred: EvaluationBudgetCandidate[];
}

export type EvaluationLaneBudgets = Record<string, number>;

function candidateOrder(left: EvaluationBudgetCandidate, right: EvaluationBudgetCandidate): number {
  if (Boolean(left.wasDeferredByBudget) !== Boolean(right.wasDeferredByBudget)) {
    return left.wasDeferredByBudget ? -1 : 1;
  }
  if (left.priorityScore !== right.priorityScore) {
    return right.priorityScore - left.priorityScore;
  }
  const leftDate = new Date(left.createdAt).getTime();
  const rightDate = new Date(right.createdAt).getTime();
  if (Number.isFinite(leftDate) && Number.isFinite(rightDate) && leftDate !== rightDate) {
    return leftDate - rightDate;
  }
  return left.id.localeCompare(right.id);
}

/**
 * Selects a bounded, lane-fair batch without turning overflow into a career
 * rejection. Deferred candidates are considered before never-deferred work so
 * a previous capacity-limited run cannot starve its backlog.
 */
export function selectEvaluationBudget(
  candidates: EvaluationBudgetCandidate[],
  laneBudgets: EvaluationLaneBudgets,
  totalLimit?: number,
): EvaluationBudgetDecision {
  const byLane = new Map<string, EvaluationBudgetCandidate[]>();
  for (const candidate of candidates) {
    const laneCandidates = byLane.get(candidate.lane) ?? [];
    laneCandidates.push(candidate);
    byLane.set(candidate.lane, laneCandidates);
  }

  const lanes = [...byLane.keys()].sort();
  const laneSelections = new Map<string, EvaluationBudgetCandidate[]>();
  const overflow: EvaluationBudgetCandidate[] = [];
  for (const lane of lanes) {
    const ordered = [...(byLane.get(lane) ?? [])].sort(candidateOrder);
    const budget = Math.max(0, Math.floor(laneBudgets[lane] ?? 0));
    laneSelections.set(lane, ordered.slice(0, budget));
    overflow.push(...ordered.slice(budget));
  }

  const fairCandidates: EvaluationBudgetCandidate[] = [];
  const maxLaneDepth = Math.max(0, ...[...laneSelections.values()].map((items) => items.length));
  for (let depth = 0; depth < maxLaneDepth; depth += 1) {
    for (const lane of lanes) {
      const candidate = laneSelections.get(lane)?.[depth];
      if (candidate) fairCandidates.push(candidate);
    }
  }

  const boundedLimit = Number.isInteger(totalLimit) && (totalLimit as number) > 0
    ? totalLimit as number
    : null;
  const selected = boundedLimit === null ? fairCandidates : fairCandidates.slice(0, boundedLimit);
  const selectedIds = new Set(selected.map((candidate) => candidate.id));
  const deferred = [
    ...overflow,
    ...fairCandidates.filter((candidate) => !selectedIds.has(candidate.id)),
  ].sort(candidateOrder);

  return { selected, deferred };
}
