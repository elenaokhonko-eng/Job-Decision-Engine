import { describe, expect, it } from 'vitest';
import {
  evaluateJobFreshness,
  evaluateMobilityMatch,
  evaluateCompensationPolicy,
  evaluateEmployerExclusions,
  evaluateEmployerWatchlist,
  computeEmploymentStabilityScore,
} from '../../policy/stage3PolicyEngine.js';
import {
  calculateStage3PriorityScore,
} from '../../services/applicationRanking.js';
import {
  applyPersistedRequirementGates,
} from '../../pipeline/hardGate.js';

describe('Stage 3: Mobility, Freshness, Compensation & Employer Watchlist', () => {
  // Scenario 1: SG permanent employee + fully remote + 30-day foreign-work allowance -> very high preference
  it('Scenario 1: SG permanent employee + fully remote + 30-day foreign-work allowance yields highest mobility score', () => {
    const job = {
      workplace_type: 'FULLY_REMOTE',
      description: 'Fully remote role for Singapore residents with global mobility benefit allowing up to 30 days temporary remote work abroad per year.',
      location: 'Singapore (Remote)',
    };

    const result = evaluateMobilityMatch(job);

    expect(result.remote_from_singapore).toBe(true);
    expect(result.temporary_abroad_allowed).toBe(true);
    expect(result.timezone_compatibility_score).toBe(100);
    expect(result.remote_freedom_score).toBe(100);
    expect(result.is_hard_reject).toBe(false);
  });

  // Scenario 2: Singapore hybrid 3 days/week -> accepted, lower preference
  it('Scenario 2: Singapore hybrid 3 days/week is accepted with lower preference score', () => {
    const job = {
      workplace_type: 'HYBRID',
      description: 'Hybrid workplace model in our Singapore office 3 days per week with 2 days remote.',
      location: 'Singapore',
    };

    const result = evaluateMobilityMatch(job);

    expect(result.is_workable).toBe(true);
    expect(result.is_hard_reject).toBe(false);
    expect(result.remote_freedom_score).toBeLessThan(70);
    expect(result.remote_freedom_score).toBeGreaterThanOrEqual(40);
  });

  // Scenario 3: Global remote but US-hours mandatory -> timezone penalty
  it('Scenario 3: Global remote with mandatory US West hours receives timezone penalty', () => {
    const job = {
      workplace_type: 'FULLY_REMOTE',
      description: 'Fully remote position worldwide. Mandatory daily Pacific Time (PST hours) working overlap with San Francisco headquarters.',
      location: 'Remote',
    };

    const result = evaluateMobilityMatch(job);

    expect(result.work_from_anywhere).toBe(true);
    expect(result.timezone_compatibility_score).toBe(20); // Heavily penalized for US West overlap
    expect(result.remote_freedom_score).toBeLessThan(80);
  });

  // Scenario 4: Remote US job but Singapore not an eligible hiring country -> workability rejection
  it('Scenario 4: Remote US job excluding non-US hiring countries triggers workability rejection', () => {
    const job = {
      workplace_type: 'FULLY_REMOTE',
      description: 'Remote software engineer. Must reside in the US. Authorized to work in the US only. Not eligible for international or Singapore residents.',
      location: 'United States (Remote)',
    };

    const result = evaluateMobilityMatch(job);

    expect(result.is_hard_reject).toBe(true);
    expect(result.rejection_code).toBe('UNWORKABLE_LOCATION_MODEL');
    expect(result.remote_from_singapore).toBe(false);
  });

  // Scenario 5: Series-A startup + SGD 8k -> below configured floor
  it('Scenario 5: Series-A startup with SGD 8k/month cash salary is flagged below floor', () => {
    const job = {
      salary_min: 8000 * 12, // SGD 96,000 / year (< SGD 10k/month floor)
      salary_currency: 'SGD',
      is_startup: true,
    };

    const result = evaluateCompensationPolicy(job, 'COMMERCIAL');

    expect(result.status).toBe('BELOW_FLOOR');
    expect(result.prevents_apply_now).toBe(true);
    expect(result.rejection_code).toBe('COMPENSATION_BELOW_USER_FLOOR');
    expect(result.evidence).toContain('SGD 10,000/month');
  });

  // Scenario 6: Old posting 75 days -> stale reject
  it('Scenario 6: Authoritative posting age of 75 days triggers GATE_STALE_POSTING hard reject', () => {
    const now = new Date('2026-10-18T00:00:00Z');
    const oldPostingDate = new Date('2026-08-04T00:00:00Z'); // 75 days old

    const result = evaluateJobFreshness(
      { posted_at: oldPostingDate.toISOString() },
      undefined,
      now
    );

    expect(result.is_hard_reject).toBe(true);
    expect(result.status).toBe('STALE');
    expect(result.rejection_code).toBe('GATE_STALE_POSTING');
    expect(result.freshness_score).toBe(0);
    expect(result.job_age_days).toBe(75);
  });

  // Scenario 7: Same role genuinely reposted today -> fresh processing
  it('Scenario 7: Genuinely reposted role with today timestamp resets freshness to 100', () => {
    const now = new Date('2026-10-18T00:00:00Z');
    const oldPostingDate = new Date('2026-07-01T00:00:00Z'); // Originally old
    const repostDate = new Date('2026-10-18T00:00:00Z'); // Reposted today with new ATS ID

    const result = evaluateJobFreshness(
      {
        posted_at: oldPostingDate.toISOString(),
        reposted_at: repostDate.toISOString(),
        is_repost: true,
      },
      undefined,
      now
    );

    expect(result.is_hard_reject).toBe(false);
    expect(result.status).toBe('FRESH');
    expect(result.freshness_score).toBe(100);
    expect(result.freshness_basis).toBe('REPOSTED_AT');
    expect(result.job_age_days).toBe(0);
  });

  // Scenario 8: Same old URL merely rediscovered today -> still stale
  it('Scenario 8: Mere rediscovery of an old vacancy without repost evidence remains stale', () => {
    const now = new Date('2026-10-18T00:00:00Z');
    const oldPostingDate = new Date('2026-07-01T00:00:00Z'); // 109 days old

    const result = evaluateJobFreshness(
      {
        posted_at: oldPostingDate.toISOString(),
        first_seen_at: now.toISOString(), // Ingestion saw it today, but posted_at is old
        is_repost: false,
      },
      undefined,
      now
    );

    expect(result.is_hard_reject).toBe(true);
    expect(result.rejection_code).toBe('GATE_STALE_POSTING');
    expect(result.freshness_basis).toBe('POSTED_AT');
  });

  // Additional Stage 3 test: Employer Exclusions
  it('hard rejects traditional Singapore insurers and body-shopping firms while allowing exceptions', () => {
    // AIA rejected
    const aia = evaluateEmployerExclusions('AIA Singapore', 'Insurance software architecture');
    expect(aia.is_excluded).toBe(true);
    expect(aia.rejection_code).toBe('GATE_EXCLUDED_EMPLOYER');

    // Mercer rejected
    const mercer = evaluateEmployerExclusions('Mercer Consulting', 'Transformation consultant');
    expect(mercer.is_excluded).toBe(true);

    // Big Four rejected
    const ey = evaluateEmployerExclusions('Ernst & Young Advisory', 'Advisory delivery');
    expect(ey.is_excluded).toBe(true);

    // Body shopping outsourcing rejected
    const outsourcing = evaluateEmployerExclusions(
      'Tech Solutions Inc',
      'Deployed across multiple client projects and billable client engagements in an IT staff augmentation model.'
    );
    expect(outsourcing.is_excluded).toBe(true);
    expect(outsourcing.matched_model).toBe('CLIENT_LEASING_BODYSHOPPING_OUTSOURCING');

    // Allowed exception EPAM is not excluded
    const epam = evaluateEmployerExclusions('EPAM Systems', 'Software engineering');
    expect(epam.is_excluded).toBe(false);
  });

  // Additional Stage 3 test: Target Company Watchlist
  it('recognizes target companies on the watchlist and awards category bonuses', () => {
    const supabase = evaluateEmployerWatchlist(
      'Supabase',
      'Open source Firebase alternative, developer infrastructure, database platform with postgres.'
    );

    expect(supabase.is_named_watchlist).toBe(true);
    expect(supabase.matched_name).toBe('Supabase');
    expect(supabase.matched_categories).toContain('DEVELOPER_INFRASTRUCTURE');
    expect(supabase.matched_categories).toContain('DATABASE_DATA_PLATFORMS');
    expect(supabase.watchlist_bonus_score).toBeGreaterThanOrEqual(40);
  });

  // Additional Stage 3 test: Freshness incorporation in final ranking
  it('demonstrates that a fresh job posted yesterday ranks higher than an equivalent 45-day-old job', () => {
    const baseRankScore = 80;

    const freshJobPriority = calculateStage3PriorityScore(baseRankScore, {
      freshnessScore: 100, // 0-3 days old
      remoteFreedomScore: 90,
    });

    const oldJobPriority = calculateStage3PriorityScore(baseRankScore, {
      freshnessScore: 40, // 31-45 days old
      remoteFreedomScore: 90,
    });

    expect(freshJobPriority).not.toBeNull();
    expect(oldJobPriority).not.toBeNull();
    // 80*0.75 + 100*0.125 + 90*0.125 = 60 + 12.5 + 11.25 = 83.75
    // 80*0.75 + 40*0.125 + 90*0.125 = 60 + 5.0 + 11.25 = 76.25
    expect(freshJobPriority!).toBeGreaterThan(oldJobPriority!);
    expect(freshJobPriority! - oldJobPriority!).toBeCloseTo(7.5, 1);
  });

  // Hard gate integration test
  it('applies the 60-day freshness gate directly within applyPersistedRequirementGates', () => {
    const now = new Date('2026-10-18T00:00:00Z');
    const staleJob = {
      title: 'Senior AI Architect',
      company_name: 'Acme AI',
      posted_at: new Date('2026-07-01T00:00:00Z').toISOString(), // >100 days old
      description: 'Building machine learning platforms.',
    };

    const gateResult = applyPersistedRequirementGates(staleJob, []);

    expect(gateResult.passed).toBe(false);
    expect(gateResult.status).toBe('HARD_REJECT');
    expect(gateResult.rejection_codes).toContain('GATE_STALE_POSTING');
  });

  // Hard gate integration test for excluded employer
  it('applies employer exclusions directly within applyPersistedRequirementGates', () => {
    const excludedJob = {
      title: 'Senior Cloud Solutions Architect',
      company_name: 'AIA Singapore',
      posted_at: new Date().toISOString(),
      description: 'Enterprise architecture for investment systems.',
    };

    const gateResult = applyPersistedRequirementGates(excludedJob, []);

    expect(gateResult.passed).toBe(false);
    expect(gateResult.status).toBe('HARD_REJECT');
    expect(gateResult.rejection_codes).toContain('GATE_EXCLUDED_EMPLOYER');
  });
});
