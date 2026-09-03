/**
 * Profile evidence contracts
 * @description Zod schemas for candidate profile data structures
 * @version 2.0
 */

import { z } from 'zod';

export const SCHEMA_VERSION = '2.0';

// ============================================================================
// Enums and base schemas
// ============================================================================

export const EngagementTypeSchema = z.enum([
  'EMPLOYEE',
  'FOUNDER_OPERATOR',
  'CONTRACTOR',
  'RESEARCHER',
]);

export const ExperienceClassSchema = z.enum([
  'PROFESSIONAL_PRODUCTION',
  'DEPLOYED_OPEN_SOURCE',
  'APPLIED_PROJECT',
  'COURSE_PROJECT',
  'KNOWLEDGE_ONLY',
]);

export const HoursPerWeekBandSchema = z.enum([
  'FULL_TIME',
  'SUBSTANTIAL_PART_TIME',
  'LIMITED',
]);

export const VerificationStatusSchema = z.enum([
  'VERIFIED',
  'SELF_ATTESTED',
  'UNVERIFIED',
]);

export const ConfidentialitySchema = z.enum([
  'PUBLIC',
  'PRIVATE_REUSABLE',
  'PRIVATE_INTERNAL',
]);

export const FactTypeSchema = z.enum([
  'ACHIEVEMENT',
  'RESPONSIBILITY',
  'PROJECT',
  'SKILL',
  'DOMAIN',
  'TECHNOLOGY',
  'PUBLICATION',
  'OPEN_SOURCE',
]);

export const CredentialTypeSchema = z.enum([
  'CERTIFICATION',
  'DEGREE',
  'COURSE',
  'LICENSE',
]);

export const CredentialStatusSchema = z.enum([
  'ACTIVE',
  'EXPIRED',
  'IN_PROGRESS',
  'REVOKED',
]);

export const ProfileVersionStatusSchema = z.enum([
  'DRAFT',
  'ACTIVE',
  'RETIRED',
]);

export const TaxonomyConceptTypeSchema = z.enum([
  'SKILL',
  'TECHNOLOGY',
  'DOMAIN',
  'FUNCTION',
  'CERTIFICATION',
  'DEGREE',
  'PUBLICATION',
  'LANGUAGE',
]);

// ============================================================================
// Date and time helpers
// ============================================================================

export const DateSchema = z.string().date();

// ============================================================================
// Candidate profile root schemas
// ============================================================================

export const CandidateProfileSchema = z.object({
  id: z.string().uuid(),
  profile_key: z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/),
  display_name: z.string().min(1).max(256),
  created_at: z.date(),
  updated_at: z.date(),
});

// ============================================================================
// Profile version
// ============================================================================

export const ProfileVersionSchema = z.object({
  id: z.string().uuid(),
  candidate_profile_id: z.string().uuid(),
  version_number: z.number().int().positive(),
  schema_version: z.string(),
  source_hash: z.string(),
  status: ProfileVersionStatusSchema,
  effective_at: z.date().nullable(),
  created_at: z.date(),
});

// ============================================================================
// Profile engagements
// ============================================================================

export const ProfileEngagementSchema = z.object({
  id: z.string().uuid(),
  profile_version_id: z.string().uuid(),
  engagement_key: z.string().regex(/^[a-z][a-z0-9_.]{1,127}$/),
  organization_legal_name: z.string().min(1).max(256),
  brand_or_program_name: z.string().max(256).nullable(),
  role_title: z.string().min(1).max(256),
  engagement_type: EngagementTypeSchema,
  experience_class: ExperienceClassSchema,
  operating_model: z.string().nullable(),
  start_date: DateSchema,
  end_date: DateSchema.nullable(),
  is_current: z.boolean(),
  production_start_date: DateSchema.nullable(),
  first_external_user_date: DateSchema.nullable(),
  hours_per_week_band: HoursPerWeekBandSchema.nullable(),
  summary: z.string().min(10).max(1024),
  verification_status: VerificationStatusSchema,
  created_at: z.date(),
});

// ============================================================================
// Taxonomy concepts
// ============================================================================

export const TaxonomyConceptSchema = z.object({
  id: z.string().uuid(),
  concept_key: z.string(),
  concept_type: TaxonomyConceptTypeSchema,
  canonical_label: z.string(),
  aliases: z.string().array(),
  parent_concept_id: z.string().uuid().nullable(),
  taxonomy_version: z.string(),
  active: z.boolean(),
  created_at: z.date(),
});

// ============================================================================
// Profile facts
// ============================================================================

export const ProfileFactSchema = z.object({
  id: z.string().uuid(),
  profile_version_id: z.string().uuid(),
  engagement_id: z.string().uuid().nullable(),
  fact_key: z.string().regex(/^[a-z][a-z0-9_.]{1,127}$/),
  fact_type: FactTypeSchema,
  statement: z.string().min(10).max(2048),
  structured_value: z.record(z.unknown()).nullable(),
  evidence_tier: ExperienceClassSchema,
  verification_status: VerificationStatusSchema,
  start_date: DateSchema.nullable(),
  end_date: DateSchema.nullable(),
  is_current: z.boolean(),
  confidentiality: ConfidentialitySchema,
  created_at: z.date(),
});

export const ProfileFactConceptSchema = z.object({
  id: z.string().uuid(),
  profile_fact_id: z.string().uuid(),
  concept_id: z.string().uuid(),
  evidence_relationship: z.string(),
  created_at: z.date(),
});

// ============================================================================
// Profile credentials
// ============================================================================

export const ProfileCredentialSchema = z.object({
  id: z.string().uuid(),
  profile_version_id: z.string().uuid(),
  credential_key: z.string().regex(/^[a-z][a-z0-9_.]{1,127}$/),
  credential_name: z.string().min(1).max(256),
  issuer: z.string().min(1).max(256),
  credential_type: CredentialTypeSchema,
  level: z.string().nullable(),
  issued_on: DateSchema.nullable(),
  expires_on: DateSchema.nullable(),
  status: CredentialStatusSchema,
  verification_status: VerificationStatusSchema,
  evidence_source_id: z.string().uuid().nullable(),
  created_at: z.date(),
});

// ============================================================================
// Evidence sources
// ============================================================================

export const EvidenceSourceSchema = z.object({
  id: z.string().uuid(),
  candidate_profile_id: z.string().uuid(),
  source_key: z.string(),
  source_type: z.string(),
  label: z.string(),
  uri: z.string().url().nullable(),
  source_date: DateSchema.nullable(),
  verification_status: VerificationStatusSchema,
  metadata: z.record(z.unknown()).nullable(),
  created_at: z.date(),
});

export const ProfileFactEvidenceSourceSchema = z.object({
  id: z.string().uuid(),
  profile_fact_id: z.string().uuid(),
  evidence_source_id: z.string().uuid(),
  created_at: z.date(),
});

// ============================================================================
// JSON file input schemas (without database IDs)
// ============================================================================

export const ProfileJsonSchema = z.object({
  schema_version: z.string(),
  profile_key: z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/),
  profile_version: z.number().int().positive(),
  display_name: z.string().min(1).max(256),
  professional_headline: z.string().max(500).optional(),
  career_objectives: z.string().max(256).array().max(10).optional(),
  status: ProfileVersionStatusSchema,
});

export const EngagementJsonSchema = z.object({
  schema_version: z.string(),
  profile_key: z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/),
  engagements: z.array(
    z.object({
      engagement_key: z.string().regex(/^[a-z][a-z0-9_.]{1,127}$/),
      organization_legal_name: z.string().min(1).max(256),
      brand_or_program_name: z.string().max(256).optional(),
      role_title: z.string().min(1).max(256),
      engagement_type: EngagementTypeSchema,
      experience_class: ExperienceClassSchema,
      operating_model: z.string().optional(),
      start_date: DateSchema,
      end_date: DateSchema.optional(),
      is_current: z.boolean(),
      production_start_date: DateSchema.optional(),
      first_external_user_date: DateSchema.optional(),
      hours_per_week_band: HoursPerWeekBandSchema.optional(),
      summary: z.string().min(10).max(1024),
      verification_status: VerificationStatusSchema,
      evidence_source_keys: z.string().array().optional(),
    })
  ),
});

export const FactJsonSchema = z.object({
  schema_version: z.string(),
  profile_key: z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/),
  facts: z.array(
    z.object({
      fact_key: z.string().regex(/^[a-z][a-z0-9_.]{1,127}$/),
      engagement_key: z.string().optional(),
      fact_type: FactTypeSchema,
      statement: z.string().min(10).max(2048),
      structured_value: z.record(z.unknown()).optional(),
      concept_keys: z.string().array().optional(),
      evidence_tier: ExperienceClassSchema,
      verification_status: VerificationStatusSchema,
      start_date: DateSchema.optional(),
      end_date: DateSchema.optional(),
      is_current: z.boolean(),
      confidentiality: ConfidentialitySchema,
      evidence_source_keys: z.string().array().optional(),
    })
  ),
});

export const CredentialJsonSchema = z.object({
  schema_version: z.string(),
  profile_key: z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/),
  credentials: z.array(
    z.object({
      credential_key: z.string().regex(/^[a-z][a-z0-9_.]{1,127}$/),
      credential_name: z.string().min(1).max(256),
      issuer: z.string().min(1).max(256),
      credential_type: CredentialTypeSchema,
      level: z.string().optional(),
      issued_on: DateSchema.optional(),
      expires_on: DateSchema.optional(),
      status: CredentialStatusSchema,
      verification_status: VerificationStatusSchema,
      evidence_source_key: z.string().optional(),
    })
  ),
});

// ============================================================================
// Work preferences (private policy, not public CV)
// ============================================================================

export const WorkModePreferenceSchema = z.object({
  preferred: z.enum(['REMOTE', 'REMOTE_FIRST', 'HYBRID', 'ONSITE']).array().optional(),
  acceptable: z.enum(['REMOTE', 'REMOTE_FIRST', 'HYBRID', 'ONSITE']).array().optional(),
  max_office_days_per_week: z.number().int().min(0).max(5).optional(),
  onsite_only_allowed: z.boolean().optional(),
});

export const WorkCompositionPreferenceSchema = z.object({
  preferred_building_research_pct_min: z.number().min(0).max(100).optional(),
  minimum_building_research_pct: z.number().min(0).max(100).optional(),
  preferred_interaction_pct_max: z.number().min(0).max(100).optional(),
  external_client_primary_allowed: z.boolean().optional(),
  people_management_primary_allowed: z.boolean().optional(),
});

export const OperationsPreferenceSchema = z.object({
  regular_on_call_allowed: z.boolean().optional(),
  shift_work_allowed: z.boolean().optional(),
  frequent_travel_allowed: z.boolean().optional(),
});

export const EmploymentPreferenceSchema = z.object({
  full_time_preferred: z.boolean().optional(),
  contract_allowed: z.boolean().optional(),
});

export const WorkPreferencesJsonSchema = z.object({
  schema_version: z.string(),
  profile_key: z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/),
  work_mode: WorkModePreferenceSchema.optional(),
  work_composition: WorkCompositionPreferenceSchema.optional(),
  operations: OperationsPreferenceSchema.optional(),
  employment: EmploymentPreferenceSchema.optional(),
});

// ============================================================================
// Lane preferences (which lanes candidate is interested in)
// ============================================================================

export const LanePreferenceSchema = z.object({
  lane_key: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  enabled: z.boolean(),
  priority_weight: z.number().min(0).max(1).optional(),
  ai_evaluation_budget: z.number().int().min(1).optional(),
});

export const LanePreferencesJsonSchema = z.object({
  schema_version: z.string(),
  profile_key: z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/),
  lanes: z.array(LanePreferenceSchema),
});
