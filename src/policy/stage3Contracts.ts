/**
 * Stage 3 Policy Contracts: Mobility, Compensation, Freshness & Employer Watchlist
 *
 * Implements versioned user/workspace preference structures rather than
 * hardcoded global policies, ensuring generic extensibility for future users.
 */

import { z } from 'zod';
export const STAGE3_SCHEMA_VERSION = '3.0.0';

// ============================================================================
// 1. Mobility Preferences
// ============================================================================

export const TimezoneRegionSchema = z.enum(['APAC', 'EUROPE', 'US_EAST', 'US_WEST']);
export type TimezoneRegion = z.infer<typeof TimezoneRegionSchema>;

export const WorkModeTypeSchema = z.enum([
  'ANY',
  'FULLY_REMOTE',
  'REMOTE_FIRST',
  'HYBRID',
  'ONSITE',
]);
export type WorkModeType = z.infer<typeof WorkModeTypeSchema>;

export const ToleranceOptionSchema = z.enum([
  'ACCEPTABLE',
  'ACCEPTABLE_LOW_PREFERENCE',
  'UNACCEPTABLE',
  'PREFER_NOT',
]);
export type ToleranceOption = z.infer<typeof ToleranceOptionSchema>;

export const MobilityPreferencesSchema = z.object({
  employment_home_base: z.string().min(2).optional(),
  preferred_work_mode: WorkModeTypeSchema.optional(),
  temporary_foreign_work_days_per_year: z.number().int().min(0).max(365).optional(),
  preferred_max_days_single_foreign_location: z.number().int().min(0).max(365).optional(),
  accept_country_list_remote: z.boolean().optional(),
  requires_residency_in_home_base: z.boolean().optional(),
  quarterly_office_visit: ToleranceOptionSchema.optional(),
  company_gatherings_1_2_per_year: ToleranceOptionSchema.optional(),
  travel_max_pct: z.number().min(0).max(100).optional(),
  hybrid_sg_1_3_days: ToleranceOptionSchema.optional(),
  timezone_preferences: z.record(TimezoneRegionSchema, z.number().min(0).max(100)).optional(),
  living_travel_excluded_regions: z.array(z.string()).optional(),
  living_travel_acceptable_regions: z.array(z.string()).optional(),
});
export type MobilityPreferences = z.infer<typeof MobilityPreferencesSchema>;

// ============================================================================
// 2. Employment Structure & Stability Preferences
// ============================================================================

export const EmploymentStructureTypeSchema = z.enum([
  'SG_EMPLOYEE',
  'EOR_EMPLOYEE',
  'DIRECT_OVERSEAS_EMPLOYEE',
  'OWN_COMPANY_CONSULTANT',
  'INDIVIDUAL_CONTRACTOR',
]);
export type EmploymentStructureType = z.infer<typeof EmploymentStructureTypeSchema>;

export const EmploymentStabilityTypeSchema = z.enum([
  'PERMANENT',
  'STARTUP_SALARY_EQUITY',
  'LONG_CONTRACT',
  'CONTRACTOR',
]);
export type EmploymentStabilityType = z.infer<typeof EmploymentStabilityTypeSchema>;

export const EmploymentStructurePreferencesSchema = z.object({
  structure_ranking: z.array(EmploymentStructureTypeSchema).optional(),
  stability_ranking: z.array(EmploymentStabilityTypeSchema).optional(),
});
export type EmploymentStructurePreferences = z.infer<typeof EmploymentStructurePreferencesSchema>;

// ============================================================================
// 3. Compensation Policy
// ============================================================================

export const OpportunityCategorySchema = z.enum([
  'COMMERCIAL',
  'UNIVERSITY_RESEARCH',
  'MISSION_MULTILATERAL',
]);
export type OpportunityCategory = z.infer<typeof OpportunityCategorySchema>;

export const CompensationPolicySchema = z.object({
  target_salary_basis: z.enum(["GROSS", "NET"]).optional(),
  fx_rate_max_age_days: z.number().int().min(1).max(90).optional(),
  startup_min_cash_salary_monthly_sgd: z.number().min(0).optional(),
  commercial_min_annual_sgd: z.number().min(0).optional(),
  commercial_target_annual_sgd: z.number().min(0).optional(),
  university_research_min_annual_sgd: z.number().min(0).optional(),
  mission_multilateral_min_annual_sgd: z.number().min(0).optional(),
  disposition_below_floor: z.enum(['HARD_REJECT', 'PREVENT_APPLY_NOW', 'WARN']).optional(),
});
export type CompensationPolicy = z.infer<typeof CompensationPolicySchema>;

// ============================================================================
// 4. Freshness Policy & Curves
// ============================================================================

export const FreshnessPolicySchema = z.object({
  max_posting_age_days: z.number().int().min(1).optional(),
  stale_gate_disposition: z.enum(['HARD_REJECT', 'DEFER', 'WARN']).optional(),
  freshness_ranking_weight: z.number().min(0).max(100).optional(),
});
export type FreshnessPolicy = z.infer<typeof FreshnessPolicySchema>;

// ============================================================================
// 5. Employer Watchlist & Category Model
// ============================================================================

export const PreferredCompanyCategorySchema = z.enum([
  'DEVELOPER_INFRASTRUCTURE',
  'DATABASE_DATA_PLATFORMS',
  'AI_FOUNDATION_MODELS',
  'AGENTIC_AI_INFRASTRUCTURE',
  'DEVELOPER_TOOLS',
  'CLOUD_PLATFORMS',
  'AI_NATIVE_PRODUCTS',
  'LEGALTECH',
  'RESEARCH_TECHNOLOGY',
  'SCIENTIFIC_COMPUTING',
  'MARKET_INVESTMENT_TECHNOLOGY',
]);
export type PreferredCompanyCategory = z.infer<typeof PreferredCompanyCategorySchema>;

export const EmployerWatchlistPreferencesSchema = z.object({
  watchlist_companies: z.array(z.string()).optional(),
  preferred_categories: z.array(PreferredCompanyCategorySchema).optional(),
  excluded_employers: z.array(z.string()).optional(),
  excluded_operating_models: z.array(z.string()).optional(),
  allowed_exceptions: z.array(z.string()).optional(),
});
export type EmployerWatchlistPreferences = z.infer<typeof EmployerWatchlistPreferencesSchema>;

// ============================================================================
// 6. Company Policy Observations
// ============================================================================

export const CompanyPolicyTypeSchema = z.enum([
  'REMOTE_POLICY',
  'COUNTRY_ELIGIBILITY',
  'TEMPORARY_WORK_ABROAD',
  'OFFICE_REQUIREMENT',
  'TIMEZONE_REQUIREMENT',
  'EMPLOYMENT_COUNTRIES',
  'EOR_SUPPORT',
  'CONTRACTOR_SUPPORT',
  'TRAVEL',
  'COMPANY_STAGE',
]);
export type CompanyPolicyType = z.infer<typeof CompanyPolicyTypeSchema>;

export const PolicySourceTypeSchema = z.enum([
  'OFFICIAL_CAREERS_PAGE',
  'HANDBOOK_PUBLIC_DOCS',
  'JOB_DESCRIPTION',
  'ENGINEERING_BLOG',
  'OFFICIAL_REGULATORY_SOURCE',
  'USER_REPORTED',
  'MEDIA_REPORTING',
  'ANECDOTAL_REVIEW',
]);
export type PolicySourceType = z.infer<typeof PolicySourceTypeSchema>;

export const CompanyPolicyObservationSchema = z.object({
  company_name: z.string(),
  policy_type: CompanyPolicyTypeSchema,
  value: z.unknown(),
  evidence_quote: z.string().nullable().default(null),
  source_url: z.string().url().nullable().default(null),
  source_type: PolicySourceTypeSchema.default('JOB_DESCRIPTION'),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']).default('HIGH'),
  observed_at: z.string(),
  effective_date: z.string().optional(),
});
export type CompanyPolicyObservation = z.infer<typeof CompanyPolicyObservationSchema>;

// ============================================================================
// 7. Full Stage 3 Preference Package
// ============================================================================

export const CompanyStageSchema = z.enum([
  'BIG_TECH',
  'PROFITABLE_SCALEUP',
  'SERIES_C_PLUS',
  'SERIES_A_B',
  'UNIVERSITY_RESEARCH_INSTITUTE',
  'GOVERNMENT_MULTILATERAL',
  'UNDERFUNDED_EARLY_STARTUP',
  'UNKNOWN',
]);
export type CompanyStage = z.infer<typeof CompanyStageSchema>;

export const CompanyStagePreferencesSchema = z.object({
  preferred: z.array(CompanyStageSchema).optional(),
  conditional: z.array(CompanyStageSchema).optional(),
  excluded: z.array(CompanyStageSchema).optional(),
  underfunded_startup_prevents_apply_now: z.boolean().optional(),
});
export type CompanyStagePreferences = z.infer<typeof CompanyStagePreferencesSchema>;

export const MarketOpportunityPreferencesSchema = z.object({
  preferred: z.array(z.string()).optional(),
  excluded: z.array(z.string()).optional(),
});
export type MarketOpportunityPreferences = z.infer<typeof MarketOpportunityPreferencesSchema>;

export const ResearchGeographyPreferencesSchema = z.object({
  preferred_regions: z.array(z.string()).optional(),
  excluded_regions: z.array(z.string()).optional(),
  excluded_institution_countries: z.array(z.string()).optional(),
});
export type ResearchGeographyPreferences = z.infer<typeof ResearchGeographyPreferencesSchema>;

export const Stage3ApplicationPriorityWeightsSchema = z.object({
  base_rank_pct: z.number().min(0).max(100),
  freshness_pct: z.number().min(0).max(100),
  remote_freedom_pct: z.number().min(0).max(100),
}).superRefine((weights, context) => {
  const total = weights.base_rank_pct + weights.freshness_pct + weights.remote_freedom_pct;
  if (total !== 100) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Stage 3 application priority weights must total 100; received ${total}.`,
    });
  }
});
export type Stage3ApplicationPriorityWeights = z.infer<typeof Stage3ApplicationPriorityWeightsSchema>;

export const Stage3WorkPreferencesSchema = z.object({
  schema_version: z.string().default(STAGE3_SCHEMA_VERSION),
  profile_key: z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/).optional(),
  mobility: MobilityPreferencesSchema.default({}),
  employment_structure: EmploymentStructurePreferencesSchema.default({}),
  compensation: CompensationPolicySchema.default({}),
  freshness: FreshnessPolicySchema.default({}),
  application_priority_weights: Stage3ApplicationPriorityWeightsSchema.optional(),
  company_stage_preferences: CompanyStagePreferencesSchema.optional(),
  market_opportunities: MarketOpportunityPreferencesSchema.optional(),
  research_geographies: ResearchGeographyPreferencesSchema.optional(),
  watchlist: EmployerWatchlistPreferencesSchema.default({}),
  culture_priorities: z.array(z.object({
    priority_order: z.number().int().positive(),
    name: z.string().min(1),
    configured_weight: z.number().min(0).max(100),
  })).optional(),
});
export type Stage3WorkPreferences = z.infer<typeof Stage3WorkPreferencesSchema>;

export interface Stage3PolicyPreferences {
  mobility?: MobilityPreferences;
  employment_structure?: EmploymentStructurePreferences;
  compensation?: CompensationPolicy;
  freshness?: FreshnessPolicy;
  watchlist?: EmployerWatchlistPreferences;
  company_stage_preferences?: CompanyStagePreferences;
}
