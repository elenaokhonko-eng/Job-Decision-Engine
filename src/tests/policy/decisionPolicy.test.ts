import { describe, it, expect } from 'vitest';
import { DEFAULT_DECISION_POLICY, evaluateDecisionPolicy } from '../../policy/decisionPolicy.js';

describe('P6: Decision policy DSL', () => {
  it('maps HARD_REJECT to INELIGIBLE/SKIP', () => {
    const out = evaluateDecisionPolicy(DEFAULT_DECISION_POLICY, {
      gate_decision: 'HARD_REJECT',
      requirement_score: 0.9,
      coverage_score: 0.9,
      evidence_completeness: 1,
    });

    expect(out.eligibility).toBe('INELIGIBLE');
    expect(out.outcome).toBe('SKIP');
    expect(out.eligibilityRuleId).toBe('eligibility_hard_reject');
    expect(out.outcomeRuleId).toBe('outcome_ineligible_skip');
  });

  it('maps NEEDS_VERIFICATION with missing scores to VERIFY/REVIEW', () => {
    const out = evaluateDecisionPolicy(DEFAULT_DECISION_POLICY, {
      gate_decision: 'NEEDS_VERIFICATION',
      requirement_score: null,
      coverage_score: null,
      evidence_completeness: 0.25,
    });

    expect(out.eligibility).toBe('VERIFY');
    expect(out.outcome).toBe('REVIEW');
    expect(out.eligibilityRuleId).toBe('eligibility_needs_verification');
    expect(out.outcomeRuleId).toBe('outcome_missing_scores_verify_review');
  });

  it('marks ELIGIBLE jobs as PRIORITY when all thresholds are met', () => {
    const out = evaluateDecisionPolicy(DEFAULT_DECISION_POLICY, {
      gate_decision: 'PASS',
      requirement_score: 0.801,
      coverage_score: 0.6,
      evidence_completeness: 0.7,
    });

    expect(out.eligibility).toBe('ELIGIBLE');
    expect(out.outcome).toBe('PRIORITY');
    expect(out.eligibilityRuleId).toBe('eligibility_pass');
    expect(out.outcomeRuleId).toBe('outcome_priority_thresholds');
  });

  it('falls back to REVIEW when requirement_score meets review threshold', () => {
    const out = evaluateDecisionPolicy(DEFAULT_DECISION_POLICY, {
      gate_decision: 'PASS',
      requirement_score: 0.5,
      coverage_score: 0.2,
      evidence_completeness: 0.1,
    });

    expect(out.outcome).toBe('REVIEW');
    expect(out.outcomeRuleId).toBe('outcome_review_threshold');
  });

  it('tracks ELIGIBLE jobs with missing match scores', () => {
    const out = evaluateDecisionPolicy(DEFAULT_DECISION_POLICY, {
      gate_decision: 'PASS',
      requirement_score: null,
      coverage_score: null,
      evidence_completeness: 0.75,
    });

    expect(out.eligibility).toBe('ELIGIBLE');
    expect(out.outcome).toBe('TRACK');
    expect(out.outcomeRuleId).toBe('outcome_missing_scores_track');
  });
});

