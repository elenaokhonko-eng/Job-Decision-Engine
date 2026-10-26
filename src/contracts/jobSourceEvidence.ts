import { z } from "zod";

export const JOB_SOURCE_EVIDENCE_SCHEMA_VERSION = "job_source_evidence_v1" as const;

export const JobEvidenceStatusSchema = z.enum(["SUPPORTED", "UNKNOWN", "CONFLICTING", "INVALID"]);
export type JobEvidenceStatus = z.infer<typeof JobEvidenceStatusSchema>;

export const JobEvidenceSpanSchema = z.object({
  evidence_key: z.string().min(1),
  source_name: z.string().min(1),
  source_plugin_key: z.string().min(1).nullable(),
  source_external_id: z.string().min(1).nullable(),
  source_url: z.string().url().nullable(),
  raw_payload_hash: z.string().min(1),
  quote_text: z.string().min(1),
  normalized_start_offset: z.number().int().min(0).nullable(),
  normalized_end_offset: z.number().int().min(0).nullable(),
  raw_start_offset: z.number().int().min(0).nullable(),
  raw_end_offset: z.number().int().min(0).nullable(),
  observed_at: z.string().datetime(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
}).superRefine((span, context) => {
  if (span.normalized_start_offset !== null && span.normalized_end_offset !== null && span.normalized_end_offset < span.normalized_start_offset) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["normalized_end_offset"], message: "Normalized evidence span end must follow its start." });
  }
  if (span.raw_start_offset !== null && span.raw_end_offset !== null && span.raw_end_offset < span.raw_start_offset) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["raw_end_offset"], message: "Raw evidence span end must follow its start." });
  }
});
export type JobEvidenceSpan = z.infer<typeof JobEvidenceSpanSchema>;

export const DescriptionSegmentSchema = z.object({
  kind: z.enum(["HEADING", "PARAGRAPH", "LIST_ITEM", "OTHER"]),
  text: z.string().min(1),
  normalized_start_offset: z.number().int().min(0),
  normalized_end_offset: z.number().int().min(1),
  raw_start_offset: z.number().int().min(0).nullable(),
  raw_end_offset: z.number().int().min(1).nullable(),
  heading_level: z.number().int().min(1).max(6).nullable().default(null),
});
export type DescriptionSegment = z.infer<typeof DescriptionSegmentSchema>;

export const DescriptionEvidenceSchema = z.object({
  normalized_text: z.string().min(1),
  normalized_text_hash: z.string().min(1),
  completeness_status: z.enum(["COMPLETE", "INCOMPLETE", "UNKNOWN"]),
  completeness_reasons: z.array(z.string()).default([]),
  segments: z.array(DescriptionSegmentSchema).default([]),
});
export type DescriptionEvidence = z.infer<typeof DescriptionEvidenceSchema>;

export const DateEvidenceSchema = z.object({
  status: JobEvidenceStatusSchema,
  value: z.string().datetime().nullable(),
  basis: z.enum(["PUBLISHED_AT", "GENUINE_REPOST_AT", "SOURCE_UPDATED_AT", "EXPIRES_AT", "RETRIEVED_AT", "UNKNOWN"]),
  raw_value: z.union([z.string(), z.number()]).nullable(),
  timestamp_unit: z.enum(["ISO_STRING", "RFC2822_STRING", "UNIX_SECONDS", "UNIX_MILLISECONDS", "UNKNOWN"]),
  evidence: z.array(JobEvidenceSpanSchema).default([]),
});
export type DateEvidence = z.infer<typeof DateEvidenceSchema>;

export const AvailabilityEvidenceSchema = z.object({
  status: z.enum(["OPEN", "CLOSED", "UNKNOWN"]),
  verified_at: z.string().datetime().nullable(),
  expires_at: z.string().datetime().nullable(),
  verification_method: z.enum(["EMPLOYER_ATS_LISTING", "EXPLICIT_SOURCE_STATUS", "EMPLOYER_APPLICATION_PAGE", "USER_SUPPLIED", "NONE"]),
  reason_code: z.string().min(1),
  evidence: z.array(JobEvidenceSpanSchema).default([]),
});
export type AvailabilityEvidence = z.infer<typeof AvailabilityEvidenceSchema>;

export const CompensationComponentSchema = z.object({
  component_type: z.enum(["BASE_CASH", "VARIABLE_CASH", "EQUITY", "OTHER"]),
  amount_min: z.number().finite().positive().nullable(),
  amount_max: z.number().finite().positive().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  period: z.enum(["HOURLY", "MONTHLY", "ANNUAL", "ONE_TIME", "UNKNOWN"]),
  guaranteed_hours_per_week: z.number().finite().positive().max(168).nullable(),
  paid_weeks_per_year: z.number().int().min(1).max(53).nullable().default(null),
  pay_basis: z.enum(["GROSS", "NET", "UNKNOWN"]),
  evidence: z.array(JobEvidenceSpanSchema).min(1),
}).superRefine((component, context) => {
  if (component.amount_min !== null && component.amount_max !== null && component.amount_max < component.amount_min) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["amount_max"], message: "Compensation maximum must not be below its minimum." });
  }
});
export type CompensationComponent = z.infer<typeof CompensationComponentSchema>;

export const CompensationEvidenceSchema = z.object({
  status: JobEvidenceStatusSchema,
  components: z.array(CompensationComponentSchema).default([]),
  evidence: z.array(JobEvidenceSpanSchema).default([]),
});
export type CompensationEvidence = z.infer<typeof CompensationEvidenceSchema>;

export const JurisdictionRequirementEvidenceSchema = z.object({
  operator: z.enum(["ANY", "ALL", "UNKNOWN"]),
  countries: z.array(z.string().min(2)).min(1),
  evidence: z.array(JobEvidenceSpanSchema).default([]),
});
export type JurisdictionRequirementEvidence = z.infer<typeof JurisdictionRequirementEvidenceSchema>;

export const JurisdictionEvidenceSchema = z.object({
  status: JobEvidenceStatusSchema,
  operator: z.enum(["ANY", "ALL", "UNKNOWN"]),
  countries: z.array(z.string().min(2)).default([]),
  requirements: z.array(JurisdictionRequirementEvidenceSchema).default([]),
  evidence: z.array(JobEvidenceSpanSchema).default([]),
});
export type JurisdictionEvidence = z.infer<typeof JurisdictionEvidenceSchema>;

export const WorkabilityEvidenceSchema = z.object({
  hiring_territories: JurisdictionEvidenceSchema,
  work_mode: z.object({
    status: JobEvidenceStatusSchema,
    value: z.enum(["REMOTE", "HYBRID", "ONSITE", "UNKNOWN"]),
    office_days_min: z.number().int().min(0).max(7).nullable(),
    office_days_max: z.number().int().min(0).max(7).nullable(),
    evidence: z.array(JobEvidenceSpanSchema).default([]),
  }),
  employment_routes: z.object({
    status: JobEvidenceStatusSchema,
    values: z.array(z.enum(["SG_EMPLOYEE", "EOR_EMPLOYEE", "DIRECT_OVERSEAS_EMPLOYEE", "OWN_COMPANY_CONSULTANT", "INDIVIDUAL_CONTRACTOR", "UNKNOWN"])).default([]),
    evidence: z.array(JobEvidenceSpanSchema).default([]),
  }),
  timezone_overlap: z.object({ status: JobEvidenceStatusSchema, value: z.string().nullable(), evidence: z.array(JobEvidenceSpanSchema).default([]) }),
  travel_pct: z.object({ status: JobEvidenceStatusSchema, minimum: z.number().min(0).max(100).nullable(), maximum: z.number().min(0).max(100).nullable(), evidence: z.array(JobEvidenceSpanSchema).default([]) }),
  on_call: z.object({ status: JobEvidenceStatusSchema, required: z.boolean().nullable(), evidence: z.array(JobEvidenceSpanSchema).default([]) }),
});
export type WorkabilityEvidence = z.infer<typeof WorkabilityEvidenceSchema>;

export const RoleShapeEvidenceSchema = z.object({
  status: JobEvidenceStatusSchema,
  role_families: z.array(z.string().min(1)).default([]),
  domain_families: z.array(z.string().min(1)).default([]),
  technical_ownership: z.enum(["MEANINGFUL", "LIMITED", "NONE", "UNKNOWN"]),
  hands_on_coding: z.enum(["REQUIRED", "PREFERRED", "NOT_REQUIRED", "UNKNOWN"]),
  architecture_scope: z.enum(["REQUIRED", "PREFERRED", "NOT_REQUIRED", "UNKNOWN"]),
  delivery_scope: z.enum(["TECHNICAL_PROJECT", "TECHNICAL_PROGRAMME", "TECHNICAL_PRODUCT", "NON_TECHNICAL", "UNKNOWN"]),
  sales_ownership: z.enum(["QUOTA_OR_CLOSING", "PROSPECTING", "TECHNICAL_SUPPORT_ONLY", "NO_EVIDENCE", "UNKNOWN"]),
  people_management: z.enum(["REQUIRED", "PREFERRED", "NOT_REQUIRED", "UNKNOWN"]),
  interaction_burden: z.enum(["LOW", "MODERATE", "HIGH", "UNKNOWN"]),
  evidence: z.array(JobEvidenceSpanSchema).default([]),
});
export type RoleShapeEvidence = z.infer<typeof RoleShapeEvidenceSchema>;

export const JobSourceEvidenceSchema = z.object({
  schema_version: z.literal(JOB_SOURCE_EVIDENCE_SCHEMA_VERSION),
  normalizer_version: z.string().min(1),
  source_name: z.string().min(1),
  source_plugin_key: z.string().min(1).nullable(),
  source_plugin_revision_id: z.string().uuid().nullable(),
  source_external_id: z.string().min(1).nullable(),
  source_identity_hash: z.string().min(1).nullable(),
  employer_posting_url: z.string().url().nullable(),
  application_url: z.string().url().nullable(),
  raw_payload_hash: z.string().min(1),
  retrieved_at: z.string().datetime(),
  description: DescriptionEvidenceSchema,
  dates: z.object({
    published_at: DateEvidenceSchema,
    reposted_at: DateEvidenceSchema,
    source_updated_at: DateEvidenceSchema,
    expires_at: DateEvidenceSchema,
  }),
  availability: AvailabilityEvidenceSchema,
  workability: WorkabilityEvidenceSchema,
  compensation: CompensationEvidenceSchema,
  role_shape: RoleShapeEvidenceSchema,
  opportunity_category: z.object({
    status: JobEvidenceStatusSchema,
    value: z.enum(["COMMERCIAL", "UNIVERSITY_RESEARCH", "MISSION_MULTILATERAL"]).nullable(),
    evidence: z.array(JobEvidenceSpanSchema).default([]),
  }),
});
export type JobSourceEvidence = z.infer<typeof JobSourceEvidenceSchema>;
