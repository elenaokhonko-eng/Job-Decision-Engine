import { describe, expect, it } from 'vitest';
import {
  calculateRanking,
  INITIAL_RANKING_WEIGHTS,
  type RankingComponents,
  type RankingPolicyConfiguration,
  type RankingReadinessContext,
} from '../../services/applicationRanking.js';

const POLICY: RankingPolicyConfiguration = {
  weights: INITIAL_RANKING_WEIGHTS,
  minimumRankingConfidence: 75,
};

const COMPLETE_COMPONENTS: RankingComponents = {
  requirementFit: 80,
  requirementCoverage: 60,
  evidenceCompleteness: 100,
  laneConfidence: 50,
  autonomy: 70,
  politicsRisk: 20,
  sensoryWorkloadRisk: 40,
  strategicValue: 90,
};

function readyContext(overrides: Partial<RankingReadinessContext> = {}): RankingReadinessContext {
  return {
    gatePassed: true,
    laneCurrent: true,
    matchCurrent: true,
    deterministicDecisionCurrent: true,
    aiEvaluationCurrent: true,
    contextVersionMismatch: false,
    policyRecheckRequired: false,
    ...overrides,
  };
}

describe('application ranking service', () => {
  it('exposes the initial caller-configurable ranking weights', () => {
    expect(INITIAL_RANKING_WEIGHTS).toEqual({
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
  });

  it('calculates the weighted rank from all configured components', () => {
    const result = calculateRanking(COMPLETE_COMPONENTS, readyContext(), POLICY);

    expect(result).toEqual({
      overallRankScore: 74.5,
      rankingConfidence: 100,
      topTenReady: true,
    });
  });

  it('uses caller-supplied weights instead of fixed algorithm weights', () => {
    const customPolicy: RankingPolicyConfiguration = {
      weights: {
        requirementFit: 0,
        requirementCoverage: 0,
        evidenceCompleteness: 0,
        laneConfidence: 0,
        autonomy: 0,
        politicsRisk: 0,
        sensoryWorkloadRisk: 0,
        strategicValue: 1,
        culturePriorityFit: 0,
      },
      minimumRankingConfidence: 100,
    };
    const result = calculateRanking(
      { ...COMPLETE_COMPONENTS, strategicValue: 20 },
      readyContext(),
      customPolicy,
    );

    expect(result.overallRankScore).toBe(20);
    expect(result.rankingConfidence).toBe(100);
  });

  it('renormalizes over available components and reduces confidence for missing weighted inputs', () => {
    const result = calculateRanking(
      {
        ...COMPLETE_COMPONENTS,
        politicsRisk: null,
        sensoryWorkloadRisk: null,
        strategicValue: null,
      },
      readyContext(),
      POLICY,
    );

    expect(result.overallRankScore).toBeCloseTo(6100 / 82.5, 10);
    expect(result.rankingConfidence).toBe(82.5);
    expect(result.topTenReady).toBe(true);
  });

  it('allows Top 10 readiness at the new 90% minimum confidence threshold', () => {
    const components = { ...COMPLETE_COMPONENTS, autonomy: null };
    const result = calculateRanking(
      components,
      readyContext(),
      { ...POLICY, minimumRankingConfidence: 90 },
    );
    const aboveNewThreshold = calculateRanking(
      components,
      readyContext(),
      { ...POLICY, minimumRankingConfidence: 95 },
    );

    expect(result.rankingConfidence).toBe(90);
    expect(result.topTenReady).toBe(true);
    expect(aboveNewThreshold.topTenReady).toBe(false);
  });

  it('allows Top 10 readiness when only the optional strategic-value signal is unknown', () => {
    const result = calculateRanking(
      { ...COMPLETE_COMPONENTS, strategicValue: null },
      readyContext(),
      { ...POLICY, minimumRankingConfidence: 95 },
    );

    expect(result.rankingConfidence).toBe(95);
    expect(result.topTenReady).toBe(true);
  });

  it.each([
    { component: 'requirementFit' as const, confidence: 62.5, score: 4450 / 62.5 },
    { component: 'requirementCoverage' as const, confidence: 85, score: 6550 / 85 },
    { component: 'evidenceCompleteness' as const, confidence: 90, score: 6450 / 90 },
    { component: 'laneConfidence' as const, confidence: 90, score: 6950 / 90 },
  ])('blocks top-ten readiness when required $component is missing', ({ component, confidence, score }) => {
    const result = calculateRanking(
      { ...COMPLETE_COMPONENTS, [component]: null },
      readyContext(),
      { ...POLICY, minimumRankingConfidence: 60 },
    );

    expect(result.overallRankScore).toBeCloseTo(score, 10);
    expect(result.rankingConfidence).toBe(confidence);
    expect(result.topTenReady).toBe(false);
  });

  it('returns no rank and zero confidence when all components are missing', () => {
    const allMissing: RankingComponents = {
      requirementFit: null,
      requirementCoverage: null,
      evidenceCompleteness: null,
      laneConfidence: null,
      autonomy: null,
      politicsRisk: null,
      sensoryWorkloadRisk: null,
      strategicValue: null,
    };
    const result = calculateRanking(allMissing, readyContext(), POLICY);

    expect(result.overallRankScore).toBeNull();
    expect(result.rankingConfidence).toBe(0);
    expect(result.topTenReady).toBe(false);
  });

  it('inverts both risk components so higher risk lowers the rank', () => {
    const result = calculateRanking(
      {
        ...COMPLETE_COMPONENTS,
        requirementFit: null,
        requirementCoverage: null,
        evidenceCompleteness: null,
        laneConfidence: null,
        autonomy: null,
        politicsRisk: 20,
        sensoryWorkloadRisk: 80,
        strategicValue: null,
      },
      readyContext(),
      { ...POLICY, minimumRankingConfidence: 0 },
    );

    expect(result.overallRankScore).toBe(56);
  });

  it.each([
    { component: 'requirementFit' as const, value: Number.NaN },
    { component: 'requirementCoverage' as const, value: Number.POSITIVE_INFINITY },
    { component: 'politicsRisk' as const, value: -0.01 },
    { component: 'strategicValue' as const, value: 100.01 },
  ])('rejects a non-finite or out-of-range $component score', ({ component, value }) => {
    expect(() =>
      calculateRanking(
        { ...COMPLETE_COMPONENTS, [component]: value },
        readyContext(),
        POLICY,
      ),
    ).toThrow(RangeError);
  });

  it.each([
    { blocker: 'a passing gate', readiness: { gatePassed: false } },
    { blocker: 'a current lane', readiness: { laneCurrent: false } },
    { blocker: 'a current match', readiness: { matchCurrent: false } },
    {
      blocker: 'a current deterministic decision',
      readiness: { deterministicDecisionCurrent: false },
    },
    { blocker: 'a current AI evaluation', readiness: { aiEvaluationCurrent: false } },
    { blocker: 'no context version mismatch', readiness: { contextVersionMismatch: true } },
    { blocker: 'no policy recheck', readiness: { policyRecheckRequired: true } },
  ])('blocks top-ten readiness without $blocker', ({ readiness }) => {
    const result = calculateRanking(COMPLETE_COMPONENTS, readyContext(readiness), POLICY);

    expect(result.topTenReady).toBe(false);
  });

  it('blocks top-ten readiness when confidence is below the configured minimum', () => {
    const result = calculateRanking(
      { ...COMPLETE_COMPONENTS, strategicValue: null },
      readyContext(),
      { ...POLICY, minimumRankingConfidence: 96 },
    );

    expect(result.rankingConfidence).toBe(95);
    expect(result.topTenReady).toBe(false);
  });
});
