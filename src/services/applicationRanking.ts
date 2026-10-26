export type RankingComponentName =
  | 'requirementFit'
  | 'requirementCoverage'
  | 'evidenceCompleteness'
  | 'laneConfidence'
  | 'autonomy'
  | 'politicsRisk'
  | 'sensoryWorkloadRisk'
  | 'strategicValue'
  | 'culturePriorityFit';

export type RankingWeights = Readonly<Record<RankingComponentName, number>>;

export interface RankingComponents {
  readonly requirementFit: number | null;
  readonly requirementCoverage: number | null;
  readonly evidenceCompleteness: number | null;
  readonly laneConfidence: number | null;
  readonly autonomy: number | null;
  readonly politicsRisk: number | null;
  readonly sensoryWorkloadRisk: number | null;
  readonly strategicValue: number | null;
  readonly culturePriorityFit?: number | null;
}

export interface RankingReadinessContext {
  readonly gatePassed: boolean;
  readonly laneCurrent: boolean;
  readonly matchCurrent: boolean;
  readonly deterministicDecisionCurrent: boolean;
  readonly aiEvaluationCurrent: boolean;
  readonly contextVersionMismatch: boolean;
  readonly policyRecheckRequired: boolean;
}

export interface RankingPolicyConfiguration {
  readonly weights: RankingWeights;
  readonly minimumRankingConfidence: number;
}

export interface RankingResult {
  readonly overallRankScore: number | null;
  readonly rankingConfidence: number;
  readonly topTenReady: boolean;
}

const RANKING_COMPONENTS: readonly RankingComponentName[] = [
  'requirementFit',
  'requirementCoverage',
  'evidenceCompleteness',
  'laneConfidence',
  'autonomy',
  'politicsRisk',
  'sensoryWorkloadRisk',
  'strategicValue',
  'culturePriorityFit',
];

const INVERSE_RISK_COMPONENTS: ReadonlySet<RankingComponentName> = new Set([
  'politicsRisk',
  'sensoryWorkloadRisk',
]);

export const INITIAL_RANKING_WEIGHTS: RankingWeights = Object.freeze({
  requirementFit: 37.5,
  requirementCoverage: 15,
  evidenceCompleteness: 10,
  laneConfidence: 10,
  autonomy: 10,
  politicsRisk: 7.5,
  sensoryWorkloadRisk: 5,
  strategicValue: 5,
  culturePriorityFit: 0,
});

function validateScores(components: RankingComponents): void {
  for (const component of RANKING_COMPONENTS) {
    const score = components[component];
    if (score !== null && score !== undefined && (!Number.isFinite(score) || score < 0 || score > 100)) {
      throw new RangeError(`${component} must be a finite score between 0 and 100`);
    }
  }
}

function getTotalWeight(policy: RankingPolicyConfiguration): number {
  let totalWeight = 0;
  for (const component of RANKING_COMPONENTS) {
    const weight = policy.weights[component];
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError(`${component} weight must be finite and non-negative`);
    }
    totalWeight += weight;
  }

  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    throw new RangeError('Ranking policy must configure a positive finite total weight');
  }
  if (
    !Number.isFinite(policy.minimumRankingConfidence) ||
    policy.minimumRankingConfidence < 0 ||
    policy.minimumRankingConfidence > 100
  ) {
    throw new RangeError('Minimum ranking confidence must be between 0 and 100');
  }

  return totalWeight;
}

function getAvailableWeight(
  components: RankingComponents,
  policy: RankingPolicyConfiguration,
): number {
  return RANKING_COMPONENTS.reduce(
    (weight, component) => components[component] === null || components[component] === undefined
      ? weight
      : weight + policy.weights[component],
    0,
  );
}

function calculateOverallRankScore(
  components: RankingComponents,
  policy: RankingPolicyConfiguration,
  availableWeight: number,
): number | null {
  if (availableWeight === 0) {
    return null;
  }

  return RANKING_COMPONENTS.reduce((weightedScore, component) => {
    const score = components[component];
    if (score === null || score === undefined) {
      return weightedScore;
    }

    const adjustedScore = INVERSE_RISK_COMPONENTS.has(component) ? 100 - score : score;
    return weightedScore + adjustedScore * (policy.weights[component] / availableWeight);
  }, 0);
}

function isTopTenReady(
  components: RankingComponents,
  readiness: RankingReadinessContext,
  policy: RankingPolicyConfiguration,
  overallRankScore: number | null,
  rankingConfidence: number,
): boolean {
  return (
    overallRankScore !== null &&
    components.requirementFit !== null &&
    components.requirementCoverage !== null &&
    components.evidenceCompleteness !== null &&
    components.laneConfidence !== null &&
    readiness.gatePassed === true &&
    readiness.laneCurrent === true &&
    readiness.matchCurrent === true &&
    readiness.deterministicDecisionCurrent === true &&
    readiness.aiEvaluationCurrent === true &&
    readiness.contextVersionMismatch === false &&
    readiness.policyRecheckRequired === false &&
    rankingConfidence >= policy.minimumRankingConfidence
  );
}

export function calculateRanking(
  components: RankingComponents,
  readiness: RankingReadinessContext,
  policy: RankingPolicyConfiguration,
): RankingResult {
  validateScores(components);
  const totalWeight = getTotalWeight(policy);
  const availableWeight = getAvailableWeight(components, policy);
  const overallRankScore = calculateOverallRankScore(components, policy, availableWeight);
  const rankingConfidence = (availableWeight / totalWeight) * 100;
  const topTenReady = isTopTenReady(components, readiness, policy, overallRankScore, rankingConfidence);

  return { overallRankScore, rankingConfidence, topTenReady };
}

// ============================================================================
// Stage 3: Freshness & Remote Freedom Priority Scoring
// ============================================================================

export interface Stage3RankingFactors {
  readonly freshnessScore: number | null;
  readonly remoteFreedomScore: number | null;
  readonly watchlistBonusScore?: number | null;
  readonly stabilityScore?: number | null;
}

export interface Stage3PriorityWeights {
  readonly baseRankWeight: number;
  readonly freshnessWeight: number;
  readonly remoteFreedomWeight: number;
}

/**
 * Incorporates freshness (10-15%) and remote freedom into final application priority
 * without altering deterministic matching or core V5 gate passed requirements.
 */
export function calculateStage3PriorityScore(
  baseRankScore: number | null,
  factors: Stage3RankingFactors,
  weights: Stage3PriorityWeights = {
    baseRankWeight: 0.75,
    freshnessWeight: 0.125, // 12.5% of overall application priority
    remoteFreedomWeight: 0.125, // 12.5% of overall application priority
  }
): number | null {
  if (baseRankScore === null) return null;
  const freshness = factors.freshnessScore ?? 50;
  const remoteFreedom = factors.remoteFreedomScore ?? 50;

  const composite =
    baseRankScore * weights.baseRankWeight +
    freshness * weights.freshnessWeight +
    remoteFreedom * weights.remoteFreedomWeight;

  return Math.max(0, Math.min(100, Number(composite.toFixed(2))));
}

