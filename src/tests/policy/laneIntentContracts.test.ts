import { describe, expect, it } from 'vitest';

import {
  APPROVED_STAGE2_LANE_WEIGHTS,
  LaneIntentPreferencesSchema,
} from '../../policy/laneIntentContracts.js';

describe('Stage 2 lane intent contract', () => {
  it('accepts explicit role, domain, organization, work-style, and research-share preferences', () => {
    const preferences = LaneIntentPreferencesSchema.parse({
      lane_weights: APPROVED_STAGE2_LANE_WEIGHTS,
      lane_preferences: {
        CORE_AI_DATA: {
          interest_rating: 5,
          preferred_role_families: ['AI_AGENTIC_ARCHITECT', 'RESEARCH_ENGINEER'],
          excluded_role_families: ['COORDINATION_HEAVY_PROGRAMME_MANAGER'],
        },
        UNIVERSITY_AI_RESEARCH: {
          acceptable_direct_research_share_pct: { minimum_pct: 20, maximum_pct: 30 },
          preferred_subdomains: ['AUDHD_NEUROBIOLOGY_AND_PATTERN_RESEARCH'],
          excluded_organization_types: ['UNITED_STATES_UNIVERSITIES'],
        },
      },
      cross_lane_work_style_signals: {
        positive: ['TECHNICAL_BUILDING_AND_ARCHITECTURE_OWNERSHIP'],
        negative: ['STEERCO_HEAVY_GOVERNANCE_LOOPS'],
      },
    });

    expect(preferences.lane_preferences.CORE_AI_DATA?.interest_rating).toBe(5);
    expect(preferences.lane_preferences.UNIVERSITY_AI_RESEARCH?.acceptable_direct_research_share_pct)
      .toEqual({ minimum_pct: 20, maximum_pct: 30 });
    expect(preferences.cross_lane_work_style_signals.negative).toContain('STEERCO_HEAVY_GOVERNANCE_LOOPS');
  });

  it('rejects inverted direct-research share ranges', () => {
    expect(() => LaneIntentPreferencesSchema.parse({
      lane_weights: APPROVED_STAGE2_LANE_WEIGHTS,
      lane_preferences: {
        UNIVERSITY_AI_RESEARCH: {
          acceptable_direct_research_share_pct: { minimum_pct: 30, maximum_pct: 20 },
        },
      },
    })).toThrow('Minimum direct-research share cannot exceed the maximum');
  });
});
