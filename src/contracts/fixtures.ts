import {
  IngestionEnvelope,
  ExtractedJob,
  JobObservation,
  CanonicalJobVersion,
  GateDecision,
  LaneDecision,
  EvaluationQueueItem,
  EvaluationResult,
  ShortlistRow,
  SCHEMA_VERSION
} from "./index.js";

export const sampleGmailEnvelope: IngestionEnvelope = {
  schema_version: SCHEMA_VERSION,
  source_type: "GMAIL_ALERT",
  source_id: "msg-gmail-101",
  source_run_id: "11111111-1111-4111-8111-111111111111",
  observed_at: "2026-08-28T12:00:00.000Z",
  raw_payload_hash: "sha256-abc123gmailhash",
  raw_payload: "<html>Job Alert: Senior AI Solutions Officer at The World Bank Group</html>",
  metadata: { subject: "Job Alert: AI Roles" }
};

export const sampleAtsObservation: JobObservation = {
  id: "22222222-2222-4222-8222-222222222222",
  source_type: "GREENHOUSE",
  source_id: "greenhouse-9988",
  source_run_id: "33333333-3333-4333-8333-333333333333",
  observed_at: "2026-08-28T12:05:00.000Z",
  company_name_raw: "Databricks",
  title_raw: "Staff Solutions Architect - GenAI",
  location_raw: "Singapore",
  workplace_type_raw: "HYBRID",
  employment_type_raw: "FULL_TIME",
  compensation_raw: "SGD 20,000/month",
  canonical_apply_url: "https://boards.greenhouse.io/databricks/jobs/9988",
  description_text: "Hands-on platform building, Spark, LLM systems...",
  raw_payload_hash: "sha256-databricks9988",
  processing_status: "PENDING",
  error_history: []
};

export const sampleDuplicateRepostVersion: CanonicalJobVersion = {
  schema_version: SCHEMA_VERSION,
  canonical_job_id: "44444444-4444-4444-8444-444444444444",
  job_version_id: "v2",
  company_name: "Lumen Technologies",
  normalized_title: "principal technology architect",
  canonical_url: "https://lumen.com/careers/arch-123",
  location_summary: "Singapore",
  workplace_type: "HYBRID",
  employment_type: "FULL_TIME",
  description_text: "Updated reposted description with platform governance...",
  version_number: 2,
  observed_at: "2026-08-28T12:10:00.000Z",
  processing_status: "RAW_STAGED"
};

export const sampleHardRejectGate: GateDecision = {
  schema_version: SCHEMA_VERSION,
  canonical_job_id: "55555555-5555-4555-8555-555555555555",
  job_version_id: "v1",
  pipeline_run_id: "66666666-6666-4666-8666-666666666666",
  gate_version: "1.0.0",
  status: "HARD_REJECT",
  rejection_codes: ["ON_SITE_EXCEEDS_MAX", "LOCATION_MISMATCH"],
  evidence_quotes: ["Requires 5 days mandatory in-office in Melbourne, Australia"],
  workability_facts: {
    office_days_min: 5,
    office_days_max: 5,
    travel_pct_max: 20,
    employment_type: "PERMANENT",
    location_restriction: "MELBOURNE, AUSTRALIA"
  },
  evaluated_at: "2026-08-28T12:15:00.000Z"
};

export const sampleNeedsVerificationGate: GateDecision = {
  schema_version: SCHEMA_VERSION,
  canonical_job_id: "77777777-7777-4777-8777-777777777777",
  job_version_id: "v1",
  pipeline_run_id: "66666666-6666-4666-8666-666666666666",
  gate_version: "1.0.0",
  status: "NEEDS_VERIFICATION",
  rejection_codes: [],
  evidence_quotes: ["Work arrangement discussed during interview"],
  workability_facts: {
    office_days_min: null,
    office_days_max: null,
    travel_pct_max: null,
    employment_type: "UNKNOWN",
    location_restriction: null
  },
  evaluated_at: "2026-08-28T12:16:00.000Z"
};

export const sampleDeferredBudgetQueueItem: EvaluationQueueItem = {
  id: "88888888-8888-4888-8888-888888888888",
  canonical_job_id: "99999999-9999-4999-8999-999999999999",
  job_version_id: "v1",
  lane: "CORE_AI_DATA",
  priority_score: 0.32,
  status: "DEFERRED_BUDGET",
  lease_id: null,
  lease_expires_at: null,
  attempt_count: 0,
  max_attempts: 3,
  last_error: null,
  enqueued_at: "2026-08-28T12:20:00.000Z",
  updated_at: "2026-08-28T12:20:00.000Z"
};

export const sampleFailedThenRetriedQueueItem: EvaluationQueueItem = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  canonical_job_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  job_version_id: "v1",
  lane: "INVESTMENT_MARKETS_FINTECH",
  priority_score: 0.45,
  status: "RETRY_WAIT",
  lease_id: null,
  lease_expires_at: null,
  attempt_count: 1,
  max_attempts: 3,
  last_error: "Rate limit 429: Provider quota exhausted",
  enqueued_at: "2026-08-28T12:25:00.000Z",
  updated_at: "2026-08-28T12:26:00.000Z"
};

export const sampleEvaluatedShortlistRow: ShortlistRow = {
  canonical_job_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  job_version_id: "v1",
  title: "Associate Senior AI Solutions Officer",
  company: "The World Bank Group",
  canonical_url: "https://worldbank.org/careers/req38014",
  source: "GREENHOUSE",
  location: "Singapore",
  workplace_type: "HYBRID",
  employment_type: "FULL_TIME",
  description: "Build governed AI systems for development finance programs.",
  gate_status: "PASS",
  rejection_codes: [],
  gate_evidence_quotes: [],
  primary_lane: "CORE_AI_DATA",
  secondary_lanes: ["INVESTMENT_MARKETS_FINTECH"],
  lane_confidence: "Medium",
  priority_score: 0.449,
  deterministic_match_score: 82.5,
  deterministic_match_coverage: 66.7,
  processing_status: "AI_EVALUATED",
  nd_friendly_score: 75,
  politics_stress_score: 35,
  sensory_overload_index: 30,
  next_action: "APPLY_AFTER_VERIFICATION",
  strategic_value: "Strong alignment with multi-lateral development bank AI initiatives.",
  recommended_cv_version: "CORE_AI_DATA",
  evaluation_summary: "Viable role pending confirmation of hybrid attendance requirements.",
  eval_provider: "openai",
  eval_is_fallback: false,
  version_mismatch: false,
  observed_at: "2026-08-28T12:00:00.000Z",
  evaluated_at: "2026-08-28T12:30:00.000Z",
  lane_matches: [],
  workability_facts: {},
  queue_status: "COMPLETED",
  latest_match_run_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  cv_document_run_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  cover_letter_document_run_id: null,
  document_ready: true
};
