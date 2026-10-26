import { z } from "zod";

export const EXPERIENCE_SCOPE_SCHEMA_VERSION = "experience_scope_v2" as const;

export const ExperienceRoleFamilySchema = z.enum([
  "HANDS_ON_SOFTWARE_ENGINEERING",
  "AI_ENGINEERING",
  "DATA_ENGINEERING",
  "ARCHITECTURE",
  "RESEARCH_SOFTWARE",
  "SCIENTIFIC_ENGINEERING",
  "TECHNICAL_DELIVERY",
  "TECHNICAL_PRODUCT",
  "SALES_OWNERSHIP",
  "CUSTOMER_SUPPORT",
  "PEOPLE_MANAGEMENT",
]);
export type ExperienceRoleFamily = z.infer<typeof ExperienceRoleFamilySchema>;

export const ExperienceDomainFamilySchema = z.enum([
  "SOFTWARE",
  "AI",
  "DATA",
  "LEGAL_REGTECH",
  "HEALTH_BIO_PHARMA",
  "INVESTMENT_MARKETS_FINTECH",
  "SOCIAL_IMPACT_MULTILATERAL",
  "UNIVERSITY_AI_RESEARCH",
]);
export type ExperienceDomainFamily = z.infer<typeof ExperienceDomainFamilySchema>;

export const ExperienceRequirementScopeSchema = z.object({
  scope_schema_version: z.literal(EXPERIENCE_SCOPE_SCHEMA_VERSION),
  minimum_years: z.number().finite().nonnegative(),
  maximum_years: z.number().finite().nonnegative().nullable().default(null),
  role_families: z.array(ExperienceRoleFamilySchema).default([]),
  domain_families: z.array(ExperienceDomainFamilySchema).default([]),
  operator: z.enum(["ANY", "ALL"]).default("ANY"),
  seniority_scope: z.string().min(1).nullable().default(null),
  duration_basis: z.enum([
    "PROFESSIONAL_PRODUCTION",
    "DEPLOYED_OPEN_SOURCE",
    "APPLIED_PROJECT",
    "COURSEWORK",
    "UNSPECIFIED",
  ]).default("PROFESSIONAL_PRODUCTION"),
  alternative_group_id: z.string().min(1).nullable().default(null),
}).superRefine((scope, context) => {
  if (scope.maximum_years !== null && scope.maximum_years < scope.minimum_years) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["maximum_years"], message: "Maximum required experience must not be below the minimum." });
  }
  if (scope.operator === "ALL" && scope.role_families.length === 0 && scope.domain_families.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["operator"], message: "ALL scope requires at least one role or domain family." });
  }
});
export type ExperienceRequirementScope = z.infer<typeof ExperienceRequirementScopeSchema>;

export const ProfileExperienceEvidenceSchema = z.object({
  scope_schema_version: z.literal(EXPERIENCE_SCOPE_SCHEMA_VERSION),
  role_families: z.array(ExperienceRoleFamilySchema).default([]),
  domain_families: z.array(ExperienceDomainFamilySchema).default([]),
  operator: z.enum(["ANY", "ALL"]).default("ANY"),
  duration_basis: z.enum([
    "PROFESSIONAL_PRODUCTION",
    "DEPLOYED_OPEN_SOURCE",
    "APPLIED_PROJECT",
    "COURSEWORK",
    "KNOWLEDGE_ONLY",
    "UNSPECIFIED",
  ]),
  interval_start: z.string().date().nullable().default(null),
  interval_end: z.string().date().nullable().default(null),
  is_current: z.boolean().default(false),
  years_lower_bound: z.number().finite().nonnegative().nullable().default(null),
  years_upper_bound: z.number().finite().nonnegative().nullable().default(null),
  aggregation_kind: z.enum(["AGGREGATE_TOTAL", "COMPONENT", "UNKNOWN"]).default("UNKNOWN"),
  aggregation_group_id: z.string().min(1).nullable().default(null),
  overlap_group_id: z.string().min(1).nullable().default(null),
  scope_complete_for_profile: z.boolean().nullable().default(null),
  evidence_basis: z.enum([
    "DATED_ENGAGEMENT_INTERVAL",
    "ATTESTED_TOTAL_DURATION",
    "ATTESTED_COMPONENT_DURATION",
    "DERIVED_FROM_VERSIONED_ENGAGEMENT",
    "UNKNOWN",
  ]),
  evidence_source_ids: z.array(z.string().min(1)).default([]),
  attestation_status: z.enum(["VERIFIED", "SELF_ATTESTED", "UNVERIFIED"]).default("UNVERIFIED"),
}).superRefine((evidence, context) => {
  if (evidence.interval_end && evidence.interval_start && evidence.interval_end < evidence.interval_start) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["interval_end"], message: "Experience interval end must not precede its start." });
  }
  if (evidence.years_lower_bound !== null && evidence.years_upper_bound !== null && evidence.years_upper_bound < evidence.years_lower_bound) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["years_upper_bound"], message: "Experience upper bound must not be below its lower bound." });
  }
});
export type ProfileExperienceEvidence = z.infer<typeof ProfileExperienceEvidenceSchema>;
