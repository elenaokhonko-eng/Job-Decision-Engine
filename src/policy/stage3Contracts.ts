/**
 * Stage 3 Policy Contracts: Mobility, Compensation, Freshness & Employer Watchlist
 *
 * Implements versioned user/workspace preference structures rather than
 * hardcoded global policies, ensuring generic extensibility for future users.
 */

import { z } from 'zod';
import { SCHEMA_VERSION, SchemaVersionSchema } from '../contracts/version.js';

export const STAGE3_SCHEMA_VERSION = '3.0.0';

// ============================================================================
// 1. Mobility Preferences
// ============================================================================

export const TimezoneRegionSchema = z.enum(['APAC', 'EUROPE', 'US_EAST', 'US_WEST']);
export type TimezoneRegion = z.infer<typeof TimezoneRegionSchema>;

export const WorkModeTypeSchema = z.enum([
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
  employment_home_base: z.string().min(2).default('SINGAPORE'),
  preferred_work_mode: WorkModeTypeSchema.default('FULLY_REMOTE'),
  temporary_foreign_work_days_per_year: z.number().int().min(0).max(365).default(90),
  preferred_max_days_single_foreign_location: z.number().int().min(0).max(365).default(30),
  quarterly_office_visit: ToleranceOptionSchema.default('ACCEPTABLE'),
  company_gatherings_1_2_per_year: ToleranceOptionSchema.default('ACCEPTABLE'),
  travel_max_pct: z.number().min(0).max(100).default(20),
  hybrid_sg_1_3_days: ToleranceOptionSchema.default('ACCEPTABLE_LOW_PREFERENCE'),
  timezone_preferences: z
    .record(TimezoneRegionSchema, z.number().min(0).max(100))
    .default({
      APAC: 100,
      EUROPE: 100,
      US_EAST: 60,
      US_WEST: 20,
    }),
  living_travel_excluded_regions: z
    .array(z.string())
    .default(['USA', 'RUSSIA', 'TAIWAN', 'INDIA', 'AFRICA']),
  living_travel_acceptable_regions: z
    .array(z.string())
    .default(['LATIN_AMERICA', 'EUROPE', 'APAC']),
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
  structure_ranking: z.array(EmploymentStructureTypeSchema).default([
    'SG_EMPLOYEE',
    'EOR_EMPLOYEE',
    'DIRECT_OVERSEAS_EMPLOYEE',
    'OWN_COMPANY_CONSULTANT',
    'INDIVIDUAL_CONTRACTOR',
  ]),
  stability_ranking: z.array(EmploymentStabilityTypeSchema).default([
    'PERMANENT',
    'STARTUP_SALARY_EQUITY',
    'LONG_CONTRACT',
    'CONTRACTOR',
  ]),
  startup_min_cash_salary_monthly_sgd: z.number().min(0).default(10000),
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
  commercial_min_annual_sgd: z.number().min(0).default(240000),
  commercial_target_annual_sgd: z.number().min(0).default(250000),
  university_research_min_annual_sgd: z.number().min(0).default(120000),
  mission_multilateral_min_annual_sgd: z.number().min(0).default(120000),
  disposition_below_floor: z.enum(['HARD_REJECT', 'PREVENT_APPLY_NOW', 'WARN']).default('PREVENT_APPLY_NOW'),
});
export type CompensationPolicy = z.infer<typeof CompensationPolicySchema>;

// ============================================================================
// 4. Freshness Policy & Curves
// ============================================================================

export const FreshnessPolicySchema = z.object({
  max_posting_age_days: z.number().int().min(1).default(60),
  stale_gate_disposition: z.enum(['HARD_REJECT', 'DEFER', 'WARN']).default('HARD_REJECT'),
  freshness_ranking_weight: z.number().min(0).max(100).default(12.5),
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
  watchlist_companies: z.array(z.string()).default([
    'Supabase',
    'Neon',
    'Clerk',
    'MongoDB',
    'Google',
    'Microsoft',
    'Meta',
    'NVIDIA',
    'GitHub',
    'Cursor',
    'Anysphere',
    'Discord',
    'LangChain',
    'LangGraph',
    'Moonshot AI',
    'Kimi',
    'Xiaomi',
    'Grab',
    'Tencent',
    'WeChat',
    'Legora',
    'Harvey',
  ]),
  preferred_categories: z.array(PreferredCompanyCategorySchema).default([
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
  ]),
  excluded_employers: z.array(z.string()).default([
    'AIA',
    'Great Eastern',
    'Mercer',
    'Prudential',
    'PwC',
    'PricewaterhouseCoopers',
    'Deloitte',
    'Ernst & Young',
    'EY',
    'KPMG',
    'Tata Consultancy Services',
    'TCS',
    'NTT Data',
    'Wipro',
    'Infosys',
    'Cognizant',
  ]),
  excluded_operating_models: z.array(z.string()).default([
    'TRADITIONAL_INSURANCE',
    'BIG_FOUR_AUDIT_CONSULTING',
    'CLIENT_LEASING_BODYSHOPPING_OUTSOURCING',
    'STAFFING_AGENCY_EMPLOYMENT',
  ]),
  allowed_exceptions: z.array(z.string()).default(['EPAM']),
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
]);
export type CompanyPolicyType = z.infer<typeof CompanyPolicyTypeSchema>;

export const PolicySourceTypeSchema = z.enum([
  'OFFICIAL_CAREERS_PAGE',
  'HANDBOOK_PUBLIC_DOCS',
  'JOB_DESCRIPTION',
  'ENGINEERING_BLOG',
  'MEDIA_REPORTING',
  'ANECDOTAL_REVIEW',
]);
export type PolicySourceType = z.infer<typeof PolicySourceTypeSchema>;

export const CompanyPolicyObservationSchema = z.object({
  company_name: z.string(),
  policy_type: CompanyPolicyTypeSchema,
  value: z.unknown(),
  evidence_quote: z.string().nullable().default(null),
  source_url: z.string().nullable().default(null),
  source_type: PolicySourceTypeSchema.default('JOB_DESCRIPTION'),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']).default('HIGH'),
  observed_at: z.string(),
  effective_date: z.string().optional(),
});
export type CompanyPolicyObservation = z.infer<typeof CompanyPolicyObservationSchema>;

// ============================================================================
// 7. Full Stage 3 Preference Package
// ============================================================================

export const Stage3WorkPreferencesSchema = z.object({
  schema_version: z.string().default(STAGE3_SCHEMA_VERSION),
  profile_key: z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/),
  mobility: MobilityPreferencesSchema.default({}),
  employment_structure: EmploymentStructurePreferencesSchema.default({}),
  compensation: CompensationPolicySchema.default({}),
  freshness: FreshnessPolicySchema.default({}),
  watchlist: EmployerWatchlistPreferencesSchema.default({}),
});
export type Stage3WorkPreferences = z.infer<typeof Stage3WorkPreferencesSchema>;
