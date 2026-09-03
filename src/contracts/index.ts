import { z } from "zod";

import { SCHEMA_VERSION, SchemaVersionSchema } from "./version.js";
export { SCHEMA_VERSION } from "./version.js";

export const SourceNameSchema = z.enum([
  "GMAIL_ALERT",
  "GREENHOUSE",
  "LEVER",
  "ASHBY",
  "HIMALAYAS",
  "JOBICY",
  "REMOTIVE",
  "WE_WORK_REMOTELY",
  "STARTUP_JOBS",
  "MANUAL_IMPORT",
  "MANUAL_STREAMLIT",
  "LINKEDIN"
]);
export type SourceName = z.infer<typeof SourceNameSchema>;

/**
 * 1. Ingestion Envelope
 * Preserves raw input payload, source identity, and cryptographic hash before extraction.
 */
export const IngestionEnvelopeSchema = z.object({
  schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
  source_type: SourceNameSchema,
  source_id: z.string().min(1),
  source_run_id: z.string().uuid(),
  observed_at: z.string().datetime(),
  raw_payload_hash: z.string().min(1),
  raw_payload: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
});
export type IngestionEnvelope = z.infer<typeof IngestionEnvelopeSchema>;

/**
 * 2. Extracted Job
 * Structured representation of a vacancy extracted from an ingestion envelope.
 */
export const ExtractedJobSchema = z.object({
  schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
  source_external_id: z.string().min(1).optional(),
  company_name: z.string().min(1),
  title: z.string().min(1),
  location_raw: z.string().default("Unknown"),
  workplace_type_raw: z.string().default("UNKNOWN"),
  employment_type_raw: z.string().default("UNKNOWN"),
  compensation_raw: z.string().default("UNKNOWN"),
  canonical_apply_url: z.string().url().or(z.string().min(1)),
  description_raw: z.string().min(1),
  published_at: z.string().datetime().optional(),
  feed_delay_hours: z.number().nonnegative().optional(),
  source_attribution: z.string().min(1).optional(),
  raw_payload: z.unknown().optional(),
});
export type ExtractedJob = z.infer<typeof ExtractedJobSchema>;

/**
 * 3. Job Observation
 * Persisted raw observation stored in `raw_job_observations`.
 */
export const JobObservationSchema = z.object({
  id: z.string().uuid(),
  source_type: SourceNameSchema,
  source_id: z.string().min(1),
  source_run_id: z.string().uuid(),
  observed_at: z.string().datetime(),
  company_name_raw: z.string().min(1),
  title_raw: z.string().min(1),
  location_raw: z.string().default("Unknown"),
  workplace_type_raw: z.string().default("UNKNOWN"),
  employment_type_raw: z.string().default("UNKNOWN"),
  compensation_raw: z.string().default("UNKNOWN"),
  canonical_apply_url: z.string().min(1),
  description_text: z.string().min(1),
  raw_payload_hash: z.string().min(1),
  processing_status: z.enum(["PENDING", "PROCESSED", "PARSE_FAILED", "FETCH_FAILED", "DESCRIPTION_INCOMPLETE"]).default("PENDING"),
  error_history: z.array(z.record(z.unknown())).default([]),
});
export type JobObservation = z.infer<typeof JobObservationSchema>;

/**
 * 4. Canonical Job & Version
 * Deduplicated canonical record and versioned snapshot.
 */
export const CanonicalJobVersionSchema = z.object({
  schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().min(1),
  company_name: z.string().min(1),
  normalized_title: z.string().min(1),
  canonical_url: z.string().min(1),
  location_summary: z.string().default("Unknown"),
  workplace_type: z.enum(["REMOTE", "HYBRID", "ONSITE", "UNKNOWN"]).default("UNKNOWN"),
  employment_type: z.string().default("UNKNOWN"),
  description_text: z.string().min(1),
  version_number: z.number().int().positive().default(1),
  observed_at: z.string().datetime(),
  processing_status: z.enum([
    "RAW_STAGED",
    "HARD_REJECTED",
    "MANUALLY_REMOVED",
    "NEEDS_VERIFICATION",
    "PREQUALIFIED",
    "ROUTING_DEFERRED",
    "LANE_ROUTED",
    "MATCHED",
    "SEMANTIC_SHORTLISTED",
    "QUEUED_FOR_AI",
    "DEFERRED_BUDGET",
    "EVALUATING",
    "AI_EVALUATED",
    "EVALUATED",
    "RETRY_WAIT",
    "NEEDS_MANUAL_REVIEW",
    "REJECTED_AFTER_EVALUATION"
  ]).default("RAW_STAGED"),
});
export type CanonicalJobVersion = z.infer<typeof CanonicalJobVersionSchema>;

/**
 * 5. Workability Facts
 * Persisted deterministic workability evidence shared by gate, queue, and UI.
 */
export const WorkabilityFactsSchema = z.object({
  office_days_min: z.number().int().min(0).max(7).nullable(),
  office_days_max: z.number().int().min(0).max(7).nullable(),
  travel_pct_max: z.number().min(0).max(100).nullable(),
  employment_type: z.enum(["PERMANENT", "CONTRACT", "UNKNOWN"]),
  location_restriction: z.string().nullable(),
});
export type WorkabilityFacts = z.infer<typeof WorkabilityFactsSchema>;

export function toEvaluationWorkabilityFacts(facts: unknown) {
  const parsed = WorkabilityFactsSchema.parse(facts);
  return {
    locationEligibility: parsed.location_restriction ? "FAIL" as const : "PASS" as const,
    officeDays: parsed.office_days_max ?? ("UNKNOWN" as const),
    travelPercentage: parsed.travel_pct_max ?? ("UNKNOWN" as const),
    isContract: parsed.employment_type === "CONTRACT",
  };
}

/**
 * 6. Gate Decision
 * Deterministic global workability gate outcome.
 */
export const GateDecisionSchema = z.object({
  schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().min(1),
  pipeline_run_id: z.string().uuid(),
  gate_version: z.string().min(1),
  status: z.enum(["PASS", "NEEDS_VERIFICATION", "HARD_REJECT"]),
  rejection_codes: z.array(z.string()).default([]),
  evidence_quotes: z.array(z.string()).default([]),
  workability_facts: WorkabilityFactsSchema,
  evaluated_at: z.string().datetime(),
});
export type GateDecision = z.infer<typeof GateDecisionSchema>;

/**
 * 6. Lane Decision
 * Multi-lane semantic classification outcome.
 */
export const LaneEnum = z.enum([
  "CORE_AI_DATA",
  "LEGAL_REGTECH",
  "HEALTH_BIO_PHARMA",
  "INVESTMENT_MARKETS_FINTECH",
  "UNCLASSIFIED"
]);
export type Lane = z.infer<typeof LaneEnum>;

export const LaneDecisionSchema = z.object({
  schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().min(1),
  pipeline_run_id: z.string().uuid(),
  model_version: z.string().min(1),
  primary_lane: LaneEnum.nullable(),
  secondary_lanes: z.array(LaneEnum).default([]),
  lane_confidence: z.enum(["High", "Medium", "Low", "None"]),
  semantic_scores: z.record(LaneEnum, z.number()).default({
    CORE_AI_DATA: 0,
    LEGAL_REGTECH: 0,
    HEALTH_BIO_PHARMA: 0,
    INVESTMENT_MARKETS_FINTECH: 0,
    UNCLASSIFIED: 0,
  }),
  lane_evidence: z.array(z.string()).default([]),
  evaluated_at: z.string().datetime(),
});
export type LaneDecision = z.infer<typeof LaneDecisionSchema>;

/**
 * 7. Evaluation Queue Item
 * Bounded AI evaluation queue row with lease management.
 */
export const EvaluationQueueItemSchema = z.object({
  id: z.string().uuid(),
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().min(1),
  lane: LaneEnum,
  priority_score: z.number(),
  status: z.enum(["PENDING", "EVALUATING", "COMPLETED", "RETRY_WAIT", "FAILED", "DEFERRED_BUDGET", "NEEDS_MANUAL_REVIEW"]).default("PENDING"),
  lease_id: z.string().uuid().nullable().default(null),
  lease_expires_at: z.string().datetime().nullable().default(null),
  attempt_count: z.number().int().nonnegative().default(0),
  max_attempts: z.number().int().positive().default(3),
  last_error: z.string().nullable().default(null),
  enqueued_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type EvaluationQueueItem = z.infer<typeof EvaluationQueueItemSchema>;

/**
 * 8. Evaluation Result
 * Full structured LLM output with cultural, risk, and career scoring.
 */
export const EvaluationResultSchema = z.object({
  schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().min(1),
  pipeline_run_id: z.string().uuid(),
  provider: z.enum(["gemini", "openai", "local", "mock"]),
  model: z.string().min(1),
  attempt: z.number().int().positive().default(1),
  is_fallback: z.boolean().default(false),
  degraded_state: z.boolean().default(false),
  evaluation_summary: z.string().min(1),
  primary_lane: LaneEnum.nullable(),
  secondary_lanes: z.array(LaneEnum).default([]),
  lane_confidence: z.enum(["High", "Medium", "Low"]),
  lane_evidence: z.string().default(""),
  nd_score: z.number().int().min(0).max(100),
  nd_friendly_score: z.number().int().min(0).max(100),
  politics_stress_score: z.number().int().min(0).max(100),
  sensory_overload_index: z.number().int().min(0).max(100),
  building_research_ratio: z.number().int().min(0).max(100),
  interaction_load: z.number().int().min(0).max(100),
  rejection_codes: z.array(z.string()).default([]),
  strategic_value: z.string().default(""),
  recommended_cv_version: z.string().default("None"),
  next_action: z.enum(["PRIORITY_APPLY", "APPLY_AFTER_VERIFICATION", "LOW_STRATEGIC_VALUE", "REJECTED"]),
  evaluated_at: z.string().datetime(),
});
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;

/**
 * 9. Shortlist Row
 * Stable read model for Streamlit UI and dashboard analytics.
 */
export const ShortlistRowSchema = z.object({
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().min(1),
  title: z.string().min(1),
  company: z.string().min(1),
  canonical_url: z.string().min(1),
  source: SourceNameSchema.default("GMAIL_ALERT"),
  location: z.string().default("Unknown"),
  workplace_type: z.string().default("UNKNOWN"),
  employment_type: z.string().default("UNKNOWN"),
  description: z.string().nullable().default(null),
  gate_status: z.enum(["PASS", "NEEDS_VERIFICATION", "HARD_REJECT"]),
  rejection_codes: z.array(z.string()).nullable().default(null),
  gate_evidence_quotes: z.array(z.string()).nullable().default(null),
  primary_lane: LaneEnum.nullable(),
  secondary_lanes: z.array(LaneEnum).default([]),
  lane_confidence: z.enum(["High", "Medium", "Low", "None"]).default("None"),
  priority_score: z.number().default(0),
  deterministic_match_score: z.number().nullable().default(null),
  deterministic_match_coverage: z.number().nullable().default(null),
  processing_status: z.string(),
  nd_friendly_score: z.number().int().min(0).max(100).nullable().default(null),
  politics_stress_score: z.number().int().min(0).max(100).nullable().default(null),
  sensory_overload_index: z.number().int().min(0).max(100).nullable().default(null),
  next_action: z.string().nullable().default(null),
  strategic_value: z.string().nullable().default(null),
  recommended_cv_version: z.string().nullable().default(null),
  evaluation_summary: z.string().nullable().default(null),
  eval_provider: z.string().nullable().default(null),
  eval_is_fallback: z.boolean().nullable().default(null),
  version_mismatch: z.boolean().default(false),
  observed_at: z.string().datetime(),
  evaluated_at: z.string().datetime().nullable().default(null),
  lane_matches: z.array(z.unknown()).nullable().default(null),
  workability_facts: z.record(z.unknown()).nullable().default(null),
  queue_status: z.string().nullable().default(null),
  latest_match_run_id: z.string().uuid().nullable().default(null),
  cv_document_run_id: z.string().uuid().nullable().default(null),
  cover_letter_document_run_id: z.string().uuid().nullable().default(null),
  document_ready: z.boolean().default(false),
});
export type ShortlistRow = z.infer<typeof ShortlistRowSchema>;
