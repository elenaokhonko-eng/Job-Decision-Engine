import { describe, expect, it } from 'vitest';
import { extractFreshnessEvidence } from '../../ingestion/freshnessEvidence.js';
import {
  evaluateJobFreshness,
  evaluateMobilityMatch,
  evaluateCompensationPolicy,
  parseCompensationEvidence,
  inferOpportunityCategory,
  evaluateEmployerExclusions,
  evaluateEmployerWatchlist,
  computeEmploymentStabilityScore,
  evaluateCompanyStagePreference,
  computeEmploymentVerifiabilityScore,
} from '../../policy/stage3PolicyEngine.js';
import {
  calculateStage3PriorityScore,
} from '../../services/applicationRanking.js';
import {
  applyPersistedRequirementGates,
} from '../../pipeline/hardGate.js';
import {
  MobilityPreferencesSchema,
  FreshnessPolicySchema,
  CompensationPolicySchema,
  EmployerWatchlistPreferencesSchema,
} from '../../policy/stage3Contracts.js';

const approvedMobility = MobilityPreferencesSchema.parse({
  employment_home_base: 'SINGAPORE',
  preferred_work_mode: 'FULLY_REMOTE',
  temporary_foreign_work_days_per_year: 90,
  preferred_max_days_single_foreign_location: 30,
  accept_country_list_remote: true,
  requires_residency_in_home_base: true,
  quarterly_office_visit: 'ACCEPTABLE',
  company_gatherings_1_2_per_year: 'ACCEPTABLE',
  travel_max_pct: 20,
  hybrid_sg_1_3_days: 'ACCEPTABLE_LOW_PREFERENCE',
  timezone_preferences: { APAC: 100, EUROPE: 100, US_EAST: 60, US_WEST: 20 },
  living_travel_excluded_regions: ['USA', 'RUSSIA', 'TAIWAN', 'INDIA', 'AFRICA'],
  living_travel_acceptable_regions: ['LATIN_AMERICA', 'EUROPE', 'APAC'],
});
const approvedFreshness = FreshnessPolicySchema.parse({
  max_posting_age_days: 60,
  stale_gate_disposition: 'HARD_REJECT',
  freshness_ranking_weight: 12.5,
});
const approvedCompensation = CompensationPolicySchema.parse({
  target_salary_basis: "GROSS",
  startup_min_cash_salary_monthly_sgd: 10000,
  commercial_min_annual_sgd: 240000,
  commercial_target_annual_sgd: 250000,
  university_research_min_annual_sgd: 120000,
  mission_multilateral_min_annual_sgd: 120000,
  disposition_below_floor: 'PREVENT_APPLY_NOW',
});
const approvedEmployerPreferences = EmployerWatchlistPreferencesSchema.parse({
  watchlist_companies: ['Supabase', 'Neon', 'Harvey'],
  preferred_categories: ['DEVELOPER_INFRASTRUCTURE', 'DATABASE_DATA_PLATFORMS', 'LEGALTECH'],
  excluded_employers: ['AIA', 'Mercer', 'Great Eastern', 'Deloitte', 'Ernst & Young'],
  excluded_operating_models: ['CLIENT_LEASING_BODYSHOPPING_OUTSOURCING', 'STAFFING_AGENCY_EMPLOYMENT'],
  allowed_exceptions: ['EPAM'],
});
const approvedStage3Preferences = {
  mobility: approvedMobility,
  freshness: approvedFreshness,
  compensation: approvedCompensation,
  watchlist: approvedEmployerPreferences,
};

describe('Stage 3: Mobility, Freshness, Compensation & Employer Watchlist', () => {
  it('has neutral schema defaults instead of user-specific preference defaults', () => {
    expect(MobilityPreferencesSchema.parse({}).employment_home_base).toBeUndefined();
    expect(CompensationPolicySchema.parse({}).commercial_min_annual_sgd).toBeUndefined();
    expect(EmployerWatchlistPreferencesSchema.parse({}).excluded_employers).toBeUndefined();
    expect(FreshnessPolicySchema.parse({}).max_posting_age_days).toBeUndefined();
  });

  it('keeps age unknown when only ingestion or source-update timestamps are present', () => {
    const extracted = extractFreshnessEvidence({
      rawPayload: { updated_at: '2026-10-18T00:00:00Z' },
      sourceName: 'ATS',
      sourceExternalId: null,
      canonicalUrl: 'https://jobs.example.test/role',
      contentHash: 'same-content',
    });
    const result = evaluateJobFreshness({
      source_updated_at: extracted.sourceUpdatedAt,
      first_seen_at: '2026-10-18T00:00:00Z',
    }, approvedFreshness, new Date('2026-10-18T00:00:00Z'));

    expect(extracted.freshnessBasis).toBeNull();
    expect(result.status).toBe('UNKNOWN');
    expect(result.job_age_days).toBeNull();
    expect(result.is_hard_reject).toBe(false);
  });

  it('does not invent an age for a new posting identity without a publication timestamp', () => {
    const result = evaluateJobFreshness({
      freshness_basis: 'NEW_POSTING_ID',
      posting_identity_is_new: true,
    }, approvedFreshness, new Date('2026-10-18T00:00:00Z'));

    expect(result.status).toBe('UNKNOWN');
    expect(result.freshness_basis).toBe('NEW_POSTING_ID');
    expect(result.job_age_days).toBeNull();
    expect(result.is_hard_reject).toBe(false);
  });

  it('preserves distinct ATS posting identities when content is unchanged', () => {
    const common = {
      rawPayload: { posted_at: '2026-10-01T00:00:00Z' },
      sourceName: 'ATS',
      canonicalUrl: 'https://jobs.example.test/role',
      contentHash: 'same-content',
    };
    const first = extractFreshnessEvidence({ ...common, sourceExternalId: 'posting-1' });
    const second = extractFreshnessEvidence({ ...common, sourceExternalId: 'posting-2' });

    expect(first.postingIdentityHash).not.toBe(second.postingIdentityHash);
    expect(first.freshnessBasis).toBe('POSTED_AT');
  });

  it('keeps posting identity stable across content revisions and tracking URL changes', () => {
    const first = extractFreshnessEvidence({
      rawPayload: { pubDate: '2026-10-01T00:00:00Z' },
      sourceName: 'ATS',
      sourceExternalId: null,
      canonicalUrl: 'https://jobs.example.test/role/?utm_source=mail&gh_src=tracking',
      contentHash: 'content-v1',
    });
    const revised = extractFreshnessEvidence({
      rawPayload: { pubDate: '2026-10-01T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' },
      sourceName: 'ATS',
      sourceExternalId: null,
      canonicalUrl: 'https://jobs.example.test/role',
      contentHash: 'content-v2',
    });

    expect(revised.postingIdentityHash).toBe(first.postingIdentityHash);
    expect(revised.sourceUpdatedAt).toBe('2026-10-20T00:00:00.000Z');
    expect(revised.freshnessBasis).toBe('POSTED_AT');
  });

  it('parses explicit seconds/milliseconds and expiry dates without treating arbitrary numbers as dates', () => {
    const seconds = extractFreshnessEvidence({
      rawPayload: { publishedAt: 1790812800, validThrough: '2026-12-31T23:59:59Z' },
      sourceName: 'ATS',
      sourceExternalId: 'job-1',
      canonicalUrl: null,
      contentHash: 'content',
    });
    const milliseconds = extractFreshnessEvidence({
      rawPayload: { datePosted: 1790812800000 },
      sourceName: 'ATS',
      sourceExternalId: 'job-2',
      canonicalUrl: null,
      contentHash: 'content',
    });
    const ambiguous = extractFreshnessEvidence({
      rawPayload: { datePosted: 17908128000 },
      sourceName: 'ATS',
      sourceExternalId: 'job-3',
      canonicalUrl: null,
      contentHash: 'content',
    });

    expect(seconds.sourcePublishedAt).toBe(new Date(1790812800 * 1000).toISOString());
    expect(seconds.sourceExpiresAt).toBe('2026-12-31T23:59:59.000Z');
    expect(milliseconds.sourcePublishedAt).toBe(new Date(1790812800000).toISOString());
    expect(ambiguous.sourcePublishedAt).toBeNull();
  });

  it('does not use anecdotal or low-confidence company-stage evidence to exclude a role', () => {
    const result = evaluateCompanyStagePreference({
      stage: 'UNDERFUNDED_EARLY_STARTUP',
      confidence: 60,
      source: 'ANECDOTAL_REVIEW',
    }, {
      excluded: ['UNDERFUNDED_EARLY_STARTUP'],
      underfunded_startup_prevents_apply_now: true,
    });

    expect(result.status).toBe('UNKNOWN');
    expect(result.score).toBeNull();
    expect(result.preventsApplyNow).toBe(false);
    expect(result.isHardReject).toBe(false);
  });

  it('uses authoritative company-stage evidence as a non-hard Apply Now preference', () => {
    const result = evaluateCompanyStagePreference({
      stage: 'UNDERFUNDED_EARLY_STARTUP',
      confidence: 95,
      source: 'OFFICIAL_COMPANY_SOURCE',
    }, {
      excluded: ['UNDERFUNDED_EARLY_STARTUP'],
      underfunded_startup_prevents_apply_now: true,
    });

    expect(result.status).toBe('EXCLUDED');
    expect(result.score).toBe(0);
    expect(result.preventsApplyNow).toBe(true);
    expect(result.isHardReject).toBe(false);
  });

  it('requires authoritative payroll and employment-structure facts for verifiability scoring', () => {
    const incomplete = computeEmploymentVerifiabilityScore({
      employment_structure: {
        score: 90,
        confidence: 95,
        source: 'OFFICIAL_JOB_POSTING',
      },
    });
    const complete = computeEmploymentVerifiabilityScore({
      payroll_consistency: {
        score: 80,
        confidence: 95,
        source: 'OFFICIAL_REGULATORY_SOURCE',
      },
      employment_structure: {
        score: 90,
        confidence: 95,
        source: 'OFFICIAL_JOB_POSTING',
      },
    });

    expect(incomplete.score).toBeNull();
    expect(complete.score).toBe(85);
    expect(complete.evidence).toContain('not a credit or mortgage-approval prediction');
  });

  // Scenario 1: SG permanent employee + fully remote + 30-day foreign-work allowance -> very high preference
  it('Scenario 1: SG permanent employee + fully remote + 30-day foreign-work allowance yields highest mobility score', () => {
    const job = {
      workplace_type: 'FULLY_REMOTE',
      description: 'Fully remote role; remote from Singapore is allowed. Global mobility benefit allows up to 30 days of temporary remote work abroad per year.',
      location: 'Singapore (Remote)',
    };

    const result = evaluateMobilityMatch(job, approvedMobility);

    expect(result.remote_from_home_base).toBe(true);
    expect(result.remote_from_home_base_status).toBe('SUPPORTED');
    expect(result.temporary_abroad_allowed).toBe(true);
    expect(result.temporary_work_abroad_status).toBe('ALLOWED');
    expect(result.timezone_compatibility_score).toBeNull();
    expect(result.remote_freedom_score).toBeGreaterThanOrEqual(85);
    expect(result.is_hard_reject).toBe(false);
  });

  // Scenario 2: Singapore hybrid 3 days/week -> accepted, lower preference
  it('Scenario 2: Singapore hybrid 3 days/week is accepted with lower preference score', () => {
    const job = {
      workplace_type: 'HYBRID',
      description: 'Hybrid workplace model in our Singapore office 3 days per week with 2 days remote.',
      location: 'Singapore',
    };

    const result = evaluateMobilityMatch(job, approvedMobility);

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

    const result = evaluateMobilityMatch(job, approvedMobility);

    expect(result.work_from_anywhere).toBe(true);
    expect(result.timezone_compatibility_score).toBe(20); // Heavily penalized for US West overlap
    expect(result.remote_freedom_score).toBeLessThanOrEqual(80);
  });

  // Scenario 4: Remote US job but Singapore not an eligible hiring country -> workability rejection
  it('Scenario 4: Remote US job excluding non-US hiring countries triggers workability rejection', () => {
    const job = {
      workplace_type: 'FULLY_REMOTE',
      description: 'Remote software engineer. Must reside in the US. Authorized to work in the US only. Not eligible for international or Singapore residents.',
      location: 'United States (Remote)',
    };

    const result = evaluateMobilityMatch(job, approvedMobility);

    expect(result.is_hard_reject).toBe(true);
    expect(result.rejection_code).toBe('UNWORKABLE_LOCATION_MODEL');
    expect(result.remote_from_home_base).toBe(false);
  });

  // Scenario 5: Series-A startup + SGD 8k -> below configured floor
  it('Scenario 5: Series-A startup with SGD 8k/month cash salary is flagged below floor', () => {
    const job = {
      salary_min: 8000 * 12, // SGD 96,000 / year (< SGD 10k/month cash floor)
      salary_currency: 'SGD',
      salary_period: 'ANNUAL' as const,
      salary_basis: 'GROSS' as const,
      component_type: 'BASE_CASH' as const,
      is_startup: true,
    };

    const result = evaluateCompensationPolicy(job, 'COMMERCIAL', approvedCompensation);

    expect(result.status).toBe('BELOW_FLOOR');
    expect(result.prevents_apply_now).toBe(true);
    expect(result.rejection_code).toBe('COMPENSATION_BELOW_USER_FLOOR');
    expect(result.evidence).toContain('SGD 10,000');
  });

  it("parses salary ranges and preserves unknown currency, basis, and component semantics", () => {
    const range = parseCompensationEvidence("SGD 220,000–260,000 gross per year base salary");
    const unknownCurrency = parseCompensationEvidence("$220k–$260k gross per year base salary");
    const variable = parseCompensationEvidence("SGD 300,000 OTE annual compensation, including commission");

    expect(range).toMatchObject({
      salary_min: 220000,
      salary_max: 260000,
      salary_currency: "SGD",
      salary_period: "ANNUAL",
      salary_basis: "GROSS",
      component_type: "BASE_CASH",
    });
    expect(unknownCurrency?.salary_currency).toBeNull();
    expect(variable?.component_type).toBe("VARIABLE_CASH");
  });

  it("treats straddling ranges, unknown currency, hourly assumptions, and non-base cash as verification", () => {
    const straddling = evaluateCompensationPolicy({
      salary_min: 220000,
      salary_max: 260000,
      salary_currency: "SGD",
      salary_period: "ANNUAL",
      salary_basis: "GROSS",
      component_type: "BASE_CASH",
    }, "COMMERCIAL", approvedCompensation);
    const unknownCurrency = evaluateCompensationPolicy({
      salary_min: 250000,
      salary_currency: null,
      salary_period: "ANNUAL",
      salary_basis: "GROSS",
      component_type: "BASE_CASH",
    }, "COMMERCIAL", approvedCompensation);
    const hourly = evaluateCompensationPolicy({
      salary_min: 100,
      salary_currency: "SGD",
      salary_period: "HOURLY",
      salary_basis: "GROSS",
      component_type: "BASE_CASH",
      guaranteed_hours_per_week: 40,
    }, "COMMERCIAL", approvedCompensation);
    const ote = evaluateCompensationPolicy({
      salary_min: 300000,
      salary_currency: "SGD",
      salary_period: "ANNUAL",
      salary_basis: "GROSS",
      component_type: "VARIABLE_CASH",
    }, "COMMERCIAL", approvedCompensation);

    expect(straddling.status).toBe("UNKNOWN");
    expect(straddling.prevents_apply_now).toBe(true);
    expect(unknownCurrency.status).toBe("UNKNOWN");
    expect(hourly.status).toBe("UNKNOWN");
    expect(ote.status).toBe("UNKNOWN");
  });

  it("does not infer a gross or net target basis when the active preference omits it", () => {
    const basisUnconfigured = CompensationPolicySchema.parse({
      commercial_min_annual_sgd: 240000,
      disposition_below_floor: "PREVENT_APPLY_NOW",
    });
    const result = evaluateCompensationPolicy({
      salary_min: 250000,
      salary_max: 250000,
      salary_currency: "SGD",
      salary_period: "ANNUAL",
      salary_basis: "GROSS",
      component_type: "BASE_CASH",
    }, "COMMERCIAL", basisUnconfigured);

    expect(result.status).toBe("UNKNOWN");
    expect(result.prevents_apply_now).toBe(true);
    expect(result.evidence).toContain("Gross/net salary basis is missing or does not match");
  });

  it("does not infer discounted compensation categories from posting keywords", () => {
    expect(inferOpportunityCategory("Acme AI", "Research Engineer", "University research is a customer domain.")).toBeNull();
    expect(inferOpportunityCategory("National University of Singapore", "Research Engineer", "")).toBe("UNIVERSITY_RESEARCH");
  });

  it("uses only supported opportunity categories and evaluates a structured maximum without inventing a minimum", () => {
    const hardRejectPreferences = {
      ...approvedStage3Preferences,
      compensation: CompensationPolicySchema.parse({
        ...approvedCompensation,
        disposition_below_floor: "HARD_REJECT",
      }),
    };
    const sharedSalary = {
      title: "Research Engineer",
      company_name: "Example Labs",
      workplace_type: "REMOTE",
      location: "Singapore",
      posted_at: new Date().toISOString(),
      salary_min: null,
      salary_currency: "SGD",
      salary_period: "ANNUAL" as const,
      salary_basis: "GROSS" as const,
      component_type: "BASE_CASH" as const,
      description: "Build software for university research customers.",
    };
    const supportedUniversity = applyPersistedRequirementGates({
      ...sharedSalary,
      salary_min: 180000,
      salary_max: 200000,
      opportunity_category: "UNIVERSITY_RESEARCH",
    }, [], undefined, null, hardRejectPreferences);
    const structuredMaximumBelowFloor = applyPersistedRequirementGates({
      ...sharedSalary,
      salary_max: 200000,
      opportunity_category: "COMMERCIAL",
    }, [], undefined, null, hardRejectPreferences);
    const structuredMaximumAboveFloor = evaluateCompensationPolicy({
      salary_min: null,
      salary_max: 260000,
      salary_currency: "SGD",
      salary_period: "ANNUAL",
      salary_basis: "GROSS",
      component_type: "BASE_CASH",
    }, "COMMERCIAL", hardRejectPreferences.compensation);

    expect(supportedUniversity.status).toBe("PASS");
    expect(structuredMaximumBelowFloor.status).toBe("HARD_REJECT");
    expect(structuredMaximumBelowFloor.rejection_codes).toContain("COMPENSATION_BELOW_USER_FLOOR");
    expect(structuredMaximumAboveFloor.status).toBe("UNKNOWN");
    expect(structuredMaximumAboveFloor.salary_annual_sgd).toBeNull();
    expect(structuredMaximumAboveFloor.salary_annual_sgd_max).toBe(260000);
  });

  // Scenario 6: Old posting 75 days -> stale reject
  it('Scenario 6: Authoritative posting age of 75 days triggers GATE_STALE_POSTING hard reject', () => {
    const now = new Date('2026-10-18T00:00:00Z');
    const oldPostingDate = new Date('2026-08-04T00:00:00Z'); // 75 days old

    const result = evaluateJobFreshness(
      { posted_at: oldPostingDate.toISOString() },
      approvedFreshness,
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
      approvedFreshness,
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
      approvedFreshness,
      now
    );

    expect(result.is_hard_reject).toBe(true);
    expect(result.rejection_code).toBe('GATE_STALE_POSTING');
    expect(result.freshness_basis).toBe('POSTED_AT');
  });

  // Additional Stage 3 test: Employer Exclusions
  it('hard rejects traditional Singapore insurers and body-shopping firms while allowing exceptions', () => {
    // AIA rejected
    const aia = evaluateEmployerExclusions('AIA Singapore', 'Insurance software architecture', approvedEmployerPreferences);
    expect(aia.is_excluded).toBe(true);
    expect(aia.rejection_code).toBe('GATE_EXCLUDED_EMPLOYER');

    // Mercer rejected
    const mercer = evaluateEmployerExclusions('Mercer Consulting', 'Transformation consultant', approvedEmployerPreferences);
    expect(mercer.is_excluded).toBe(true);

    // Big Four rejected
    const ey = evaluateEmployerExclusions('Ernst & Young Advisory', 'Advisory delivery', approvedEmployerPreferences);
    expect(ey.is_excluded).toBe(true);

    // Body shopping outsourcing rejected
    const outsourcing = evaluateEmployerExclusions(
      'Tech Solutions Inc',
      'Deployed across multiple client projects and billable client engagements in an IT staff augmentation model.',
      approvedEmployerPreferences
    );
    expect(outsourcing.is_excluded).toBe(true);
    expect(outsourcing.matched_model).toBe('CLIENT_LEASING_BODYSHOPPING_OUTSOURCING');

    // Allowed exception EPAM is not excluded
    const epam = evaluateEmployerExclusions('EPAM Systems', 'Software engineering', approvedEmployerPreferences);
    expect(epam.is_excluded).toBe(false);
  });

  // Additional Stage 3 test: Target Company Watchlist
  it('recognizes target companies on the watchlist and awards category bonuses', () => {
    const supabase = evaluateEmployerWatchlist(
      'Supabase',
      'Open source Firebase alternative, developer infrastructure, database platform with postgres.',
      approvedEmployerPreferences
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

    const gateResult = applyPersistedRequirementGates(staleJob, [], undefined, null, approvedStage3Preferences);

    expect(gateResult.passed).toBe(false);
    expect(gateResult.status).toBe('HARD_REJECT');
    expect(gateResult.rejection_codes).toContain('GATE_STALE_POSTING');
  });

  it('keeps below-floor compensation out of hard-reject gates when policy only prevents Apply Now', () => {
    const result = applyPersistedRequirementGates({
      title: 'Senior AI Engineer',
      company_name: 'Acme AI',
      posted_at: new Date().toISOString(),
      compensation_raw: 'SGD 8,000 per month',
      description: 'Build AI systems for enterprise customers.',
    }, [], undefined, null, approvedStage3Preferences);

    expect(result.passed).toBe(true);
    expect(result.status).toBe('PASS');
    expect(result.rejection_codes).not.toContain('COMPENSATION_BELOW_USER_FLOOR');
  });

  // Hard gate integration test for excluded employer
  it('applies employer exclusions directly within applyPersistedRequirementGates', () => {
    const excludedJob = {
      title: 'Senior Cloud Solutions Architect',
      company_name: 'AIA Singapore',
      posted_at: new Date().toISOString(),
      description: 'Enterprise architecture for investment systems.',
    };

    const gateResult = applyPersistedRequirementGates(excludedJob, [], undefined, null, approvedStage3Preferences);

    expect(gateResult.passed).toBe(false);
    expect(gateResult.status).toBe('HARD_REJECT');
    expect(gateResult.rejection_codes).toContain('GATE_EXCLUDED_EMPLOYER');
  });
});
