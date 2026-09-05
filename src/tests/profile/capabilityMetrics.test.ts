import { describe, it, expect } from 'vitest';
import {
  mergeDayIntervals,
  sumMergedIntervalDays,
  computeAllocationWeightedDays,
  computeConceptCapabilityMetrics,
} from '../../profile/capabilityMetrics.js';
import { DEFAULT_EVIDENCE_STRENGTH_POLICY } from '../../evidence/evidenceStrengthPolicy.js';

describe('P4: capability metrics determinism and overlap handling', () => {
  it('merges overlapping/adjacent day intervals without double counting', () => {
    const merged = mergeDayIntervals([
      { startDay: 0, endDay: 2 },
      { startDay: 2, endDay: 4 }, // adjacent/overlap at day 2
      { startDay: 10, endDay: 10 },
      { startDay: 9, endDay: 9 }, // adjacent to 10
    ]);

    expect(merged).toEqual([
      { startDay: 0, endDay: 4 },
      { startDay: 9, endDay: 10 },
    ]);
    expect(sumMergedIntervalDays(merged)).toBe(7);
  });

  it('caps allocation-weighted duration so overlapping work never double counts', () => {
    const res = computeAllocationWeightedDays([
      { startDay: 0, endDay: 9, weight: 0.6, sourceKey: 'e1' }, // 10 days
      { startDay: 4, endDay: 14, weight: 0.6, sourceKey: 'e2' }, // 11 days, overlap 5 days (4..9)
    ]);

    // days 0..3: 4 * 0.6 = 2.4
    // days 4..9: 6 * min(1, 1.2) = 6
    // days 10..14: 5 * 0.6 = 3
    expect(res.value).toBe(11.4);
    expect(res.trace.missingWeightSources).toHaveLength(0);
  });

  it('returns null allocation-weighted duration when any hours-per-week band is unknown', () => {
    const res = computeAllocationWeightedDays([
      { startDay: 0, endDay: 2, weight: null, sourceKey: 'e1' },
    ]);
    expect(res.value).toBeNull();
    expect(res.trace.missingWeightSources).toEqual(['e1']);
  });

  it('computes stable concept metrics and hash for identical inputs', () => {
    const hoursBandWeights = DEFAULT_EVIDENCE_STRENGTH_POLICY.hours_per_week_band_weights as Record<
      string,
      number
    >;

    const input = {
      asOfDate: '2025-01-20',
      conceptKey: 'python',
      conceptType: 'SKILL',
      engagements: [
        {
          engagement_id: 'e1',
          start_date: '2025-01-01',
          end_date: '2025-01-10',
          is_current: false,
          hours_per_week_band: 'SUBSTANTIAL_PART_TIME',
        },
        {
          engagement_id: 'e2',
          start_date: '2025-01-05',
          end_date: '2025-01-15',
          is_current: false,
          hours_per_week_band: 'SUBSTANTIAL_PART_TIME',
        },
      ],
      facts: [
        {
          fact_id: 'f1',
          fact_type: 'PROJECT',
          engagement_id: 'e1',
          evidence_tier: 'PROFESSIONAL_PRODUCTION',
          verification_status: 'SELF_ATTESTED',
        },
        {
          fact_id: 'f2',
          fact_type: 'SKILL',
          engagement_id: 'e2',
          evidence_tier: 'APPLIED_PROJECT',
          verification_status: 'UNVERIFIED',
        },
      ],
      evidenceStrengthPolicy: DEFAULT_EVIDENCE_STRENGTH_POLICY,
      hoursBandWeights,
    } as const;

    const a = computeConceptCapabilityMetrics(input);
    const b = computeConceptCapabilityMetrics(input);

    expect(a.metrics).toEqual({
      calendar_days: 15,
      allocation_weighted_days: 11.4,
      recency_days: 5,
      engagement_count: 2,
      fact_count: 2,
      project_count: 1,
      evidence_strength_max: 0.7,
    });
    expect(b.metrics).toEqual(a.metrics);
    expect(b.metricsHash).toBe(a.metricsHash);
  });
});

