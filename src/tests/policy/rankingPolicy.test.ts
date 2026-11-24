import { describe, expect, it } from 'vitest';
import {
  calculateRanking,
  INITIAL_RANKING_WEIGHTS,
  RANKING_COMPOSITE_VERSION,
  type RankingComponents,
  type RankingPolicyConfiguration,
  type RankingReadinessContext,
} from '../../services/applicationRanking.js';
import { parseRankingWeights } from '../../services/applicationRankingMaterializer.js';

const POLICY: RankingPolicyConfiguration = {
  weights: INITIAL_RANKING_WEIGHTS,
  minimumRankingConfidence: 75,
};

const COMPLETE_COMPONENTS: RankingComponents = {
  requirementFit: 80,
  requirementCoverage: 60,
  evidenceCompleteness: 70,
  laneConfidence: 100,
};

function readyContext(overrides: Partial<RankingReadinessContext> = {}): RankingReadinessContext {
  return {
    gatePassed: true,
    laneCurrent: true,
    matchCurrent: true,
    deterministicDecisionCurrent: true,
    contextVersionMismatch: false,
    policyRecheckRequired: false,
    ...overrides,
  };
}

describe('application ranking service (deterministic composite)', () => {
  it('weights only the four deterministic terms: 37.5 / 15 / 10 / 10 (total 72.5)', () => {
    expect(INITIAL_RANKING_WEIGHTS).toEqual({
      requirementFit: 37.5,
      requirementCoverage: 15,
      evidenceCompleteness: 10,
      laneConfidence: 10,
    });
    expect(Object.values(INITIAL_RANKING_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(72.5);
    expect(RANKING_COMPOSITE_VERSION).toBe('deterministic_composite_v2');
  });

  it('proves the composite for fixed inputs: (80*37.5 + 60*15 + 70*10 + 100*10) / 72.5 = 77.241', () => {
    const result = calculateRanking(COMPLETE_COMPONENTS, readyContext(), POLICY);

    expect(result.overallRankScore).toBeCloseTo(5600 / 72.5, 10);
    expect(result.overallRankScore).toBeCloseTo(77.241, 3);
    expect(result.rankingConfidence).toBe(100);
    expect(result.topTenReady).toBe(true);
  });

  it('shares of the composite are about half, a fifth, and a seventh each', () => {
    const total = 72.5;
    expect(INITIAL_RANKING_WEIGHTS.requirementFit / total).toBeCloseTo(0.5172, 4);
    expect(INITIAL_RANKING_WEIGHTS.requirementCoverage / total).toBeCloseTo(0.2069, 4);
    expect(INITIAL_RANKING_WEIGHTS.evidenceCompleteness / total).toBeCloseTo(0.1379, 4);
    expect(INITIAL_RANKING_WEIGHTS.laneConfidence / total).toBeCloseTo(0.1379, 4);
  });

  it('a Low (30) lane confidence costs about 9.7 composite points against High', () => {
    const high = calculateRanking(COMPLETE_COMPONENTS, readyContext(), POLICY).overallRankScore!;
    const low = calculateRanking({ ...COMPLETE_COMPONENTS, laneConfidence: 30 }, readyContext(), POLICY).overallRankScore!;

    expect(high - low).toBeCloseTo(70 * (10 / 72.5), 10);
  });

  it('uses caller-supplied weights instead of fixed algorithm weights', () => {
    const result = calculateRanking(
      { ...COMPLETE_COMPONENTS, requirementCoverage: 20 },
      readyContext(),
      {
        weights: { requirementFit: 0, requirementCoverage: 1, evidenceCompleteness: 0, laneConfidence: 0 },
        minimumRankingConfidence: 100,
      },
    );

    expect(result.overallRankScore).toBe(20);
    expect(result.rankingConfidence).toBe(100);
  });

  it('ignores AI label values entirely: shuffled AI values give the same composite and the same order', () => {
    // The AI labels are not part of RankingComponents, so they cannot reach calculateRanking. The
    // property is checked by ranking a set of jobs with every permutation of arbitrary AI values.
    const jobs = [
      { id: 'a', components: { requirementFit: 90, requirementCoverage: 70, evidenceCompleteness: 80, laneConfidence: 100 } },
      { id: 'b', components: { requirementFit: 85, requirementCoverage: 90, evidenceCompleteness: 60, laneConfidence: 65 } },
      { id: 'c', components: { requirementFit: 60, requirementCoverage: 50, evidenceCompleteness: 90, laneConfidence: 30 } },
      { id: 'd', components: { requirementFit: 75, requirementCoverage: 75, evidenceCompleteness: 75, laneConfidence: 100 } },
    ];
    const aiValueSets = [
      { autonomy: 0, politicsRisk: 100, sensoryWorkloadRisk: 100 },
      { autonomy: 100, politicsRisk: 0, sensoryWorkloadRisk: 0 },
      { autonomy: 50, politicsRisk: 50, sensoryWorkloadRisk: 50 },
      { autonomy: null, politicsRisk: null, sensoryWorkloadRisk: null },
    ];
    const orderFor = (aiValues: (typeof aiValueSets)[number], shift: number) => {
      const labelled = jobs.map((job, index) => ({
        ...job,
        ai: { ...aiValues, autonomy: aiValues.autonomy === null ? null : (aiValues.autonomy + shift * index) % 101 },
      }));
      return labelled
        .map((job) => ({ id: job.id, score: calculateRanking(job.components, readyContext(), POLICY).overallRankScore! }))
        .sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
    };
    const baseline = orderFor(aiValueSets[0], 0);
    for (const values of aiValueSets) {
      for (const shift of [0, 7, 33, 100]) {
        expect(orderFor(values, shift)).toEqual(baseline);
      }
    }
  });

  it('renormalizes over available components and reduces confidence for a missing optional input', () => {
    // All four terms are required for Top 10; the composite still renormalises when one is absent.
    const result = calculateRanking(
      { ...COMPLETE_COMPONENTS, evidenceCompleteness: null },
      readyContext(),
      { ...POLICY, minimumRankingConfidence: 0 },
    );

    expect(result.overallRankScore).toBeCloseTo((80 * 37.5 + 60 * 15 + 100 * 10) / 62.5, 10);
    expect(result.rankingConfidence).toBeCloseTo((62.5 / 72.5) * 100, 10);
    expect(result.topTenReady).toBe(false);
  });

  it.each([
    { component: 'requirementFit' as const },
    { component: 'requirementCoverage' as const },
    { component: 'evidenceCompleteness' as const },
    { component: 'laneConfidence' as const },
  ])('blocks top-ten readiness when required $component is missing', ({ component }) => {
    const result = calculateRanking(
      { ...COMPLETE_COMPONENTS, [component]: null },
      readyContext(),
      { ...POLICY, minimumRankingConfidence: 0 },
    );

    expect(result.overallRankScore).not.toBeNull();
    expect(result.topTenReady).toBe(false);
  });

  it('returns no rank and zero confidence when all components are missing', () => {
    const allMissing: RankingComponents = {
      requirementFit: null,
      requirementCoverage: null,
      evidenceCompleteness: null,
      laneConfidence: null,
    };
    const result = calculateRanking(allMissing, readyContext(), POLICY);

    expect(result.overallRankScore).toBeNull();
    expect(result.rankingConfidence).toBe(0);
    expect(result.topTenReady).toBe(false);
  });

  it.each([
    { component: 'requirementFit' as const, value: Number.NaN },
    { component: 'requirementCoverage' as const, value: Number.POSITIVE_INFINITY },
    { component: 'evidenceCompleteness' as const, value: -0.01 },
    { component: 'laneConfidence' as const, value: 100.01 },
  ])('rejects a non-finite or out-of-range $component score', ({ component, value }) => {
    expect(() =>
      calculateRanking({ ...COMPLETE_COMPONENTS, [component]: value }, readyContext(), POLICY),
    ).toThrow(RangeError);
  });

  it.each([
    { blocker: 'a passing gate', readiness: { gatePassed: false } },
    { blocker: 'a current lane', readiness: { laneCurrent: false } },
    { blocker: 'a current match', readiness: { matchCurrent: false } },
    { blocker: 'a current deterministic decision', readiness: { deterministicDecisionCurrent: false } },
    { blocker: 'no context version mismatch', readiness: { contextVersionMismatch: true } },
    { blocker: 'no policy recheck', readiness: { policyRecheckRequired: true } },
  ])('blocks top-ten readiness without $blocker', ({ readiness }) => {
    const result = calculateRanking(COMPLETE_COMPONENTS, readyContext(readiness), POLICY);

    expect(result.topTenReady).toBe(false);
  });

  it('does not require a current AI evaluation for Top 10 readiness', () => {
    // RankingReadinessContext has no AI-evaluation field any more; readiness is deterministic only.
    expect(Object.keys(readyContext())).not.toContain('aiEvaluationCurrent');
    expect(calculateRanking(COMPLETE_COMPONENTS, readyContext(), POLICY).topTenReady).toBe(true);
  });

  it('rejects a minimum confidence outside 0..100', () => {
    expect(() =>
      calculateRanking(COMPLETE_COMPONENTS, readyContext(), { ...POLICY, minimumRankingConfidence: 101 }),
    ).toThrow(RangeError);
  });
});

describe('parseRankingWeights (policy row to composite weights)', () => {
  const NEW_ROW = {
    requirementFit: 37.5,
    requirementCoverage: 15,
    evidenceCompleteness: 10,
    laneConfidence: 10,
    autonomy: 0,
    politicsRisk: 0,
    sensoryWorkloadRisk: 0,
    strategicValue: 0,
  };

  it('accepts the migration 122 policy row and returns only the four deterministic weights', () => {
    expect(parseRankingWeights(NEW_ROW)).toEqual(INITIAL_RANKING_WEIGHTS);
  });

  it('accepts a row that omits the retired AI keys', () => {
    expect(parseRankingWeights({ requirementFit: 1, requirementCoverage: 1, evidenceCompleteness: 1, laneConfidence: 1 }))
      .toEqual({ requirementFit: 1, requirementCoverage: 1, evidenceCompleteness: 1, laneConfidence: 1 });
  });

  it.each(['autonomy', 'politicsRisk', 'sensoryWorkloadRisk', 'strategicValue', 'culturePriorityFit'])(
    'rejects an old-shape policy that still weights %s (invariant 11)',
    (name) => {
      expect(() => parseRankingWeights({ ...NEW_ROW, [name]: 5 })).toThrow(/display-only and must be 0/);
    },
  );

  it('rejects unknown keys and missing or negative deterministic weights', () => {
    expect(() => parseRankingWeights({ ...NEW_ROW, mystery: 0 })).toThrow(/unsupported/);
    expect(() => parseRankingWeights({ ...NEW_ROW, laneConfidence: undefined })).toThrow(/invalid laneConfidence/);
    expect(() => parseRankingWeights({ ...NEW_ROW, requirementFit: -1 })).toThrow(/invalid requirementFit/);
    expect(() => parseRankingWeights([])).toThrow(/not a JSON object/);
  });
});
