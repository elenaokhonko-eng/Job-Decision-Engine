/**
 * Field Lineage Registry
 * Maps each ShortlistRow consumer field to its authoritative producer and database origin.
 */

export interface FieldLineageEntry {
  field: string;
  sourceTable: string;
  sourceColumn: string;
  producerStage: string;
  transformation: string;
  nullable: boolean;
}

export const SHORTLIST_FIELD_LINEAGE: FieldLineageEntry[] = [
  {
    field: "canonical_job_id",
    sourceTable: "canonical_jobs",
    sourceColumn: "id",
    producerStage: "normalize.ts",
    transformation: "UUID generated or matched on (normalized_title, company_name)",
    nullable: false
  },
  {
    field: "job_version_id",
    sourceTable: "job_versions",
    sourceColumn: "id",
    producerStage: "normalize.ts",
    transformation: "Version key assigned per unique description hash",
    nullable: false
  },
  {
    field: "title",
    sourceTable: "canonical_jobs",
    sourceColumn: "normalized_title",
    producerStage: "normalize.ts",
    transformation: "Lowercased & trimmed title normalization",
    nullable: false
  },
  {
    field: "company",
    sourceTable: "canonical_jobs",
    sourceColumn: "company_name",
    producerStage: "normalize.ts",
    transformation: "Cleaned entity company name",
    nullable: false
  },
  {
    field: "canonical_url",
    sourceTable: "canonical_jobs",
    sourceColumn: "canonical_url",
    producerStage: "normalize.ts",
    transformation: "Sanitized tracking-free application URL",
    nullable: false
  },
  {
    field: "source",
    sourceTable: "raw_job_observations",
    sourceColumn: "source_name",
    producerStage: "sourceBroker.ts",
    transformation: "Latest observation for the displayed job version",
    nullable: false
  },
  {
    field: "location",
    sourceTable: "canonical_jobs",
    sourceColumn: "location_summary",
    producerStage: "normalize.ts",
    transformation: "Extracted or inferred geographical location",
    nullable: false
  },
  {
    field: "workplace_type",
    sourceTable: "canonical_jobs",
    sourceColumn: "workplace_type",
    producerStage: "normalize.ts",
    transformation: "REMOTE / HYBRID / ONSITE classification",
    nullable: false
  },
  {
    field: "employment_type",
    sourceTable: "canonical_jobs",
    sourceColumn: "employment_type",
    producerStage: "normalize.ts",
    transformation: "Normalized employment classification",
    nullable: false
  },
  {
    field: "description",
    sourceTable: "job_versions",
    sourceColumn: "description_text",
    producerStage: "normalize.ts",
    transformation: "Description for the displayed job version",
    nullable: true
  },
  {
    field: "gate_status",
    sourceTable: "canonical_jobs",
    sourceColumn: "gate_decision",
    producerStage: "hardGate.ts",
    transformation: "PASS / NEEDS_VERIFICATION / HARD_REJECT",
    nullable: false
  },
  {
    field: "rejection_codes",
    sourceTable: "gate_decisions",
    sourceColumn: "rejection_codes",
    producerStage: "hardGate.ts",
    transformation: "Stored deterministic gate reason codes",
    nullable: true
  },
  {
    field: "gate_evidence_quotes",
    sourceTable: "gate_decisions",
    sourceColumn: "evidence_quotes",
    producerStage: "hardGate.ts",
    transformation: "Stored gate evidence quotes",
    nullable: true
  },
  {
    field: "primary_lane",
    sourceTable: "canonical_jobs",
    sourceColumn: "primary_lane",
    producerStage: "laneRouter.ts",
    transformation: "Primary semantic lane key assigned from YAML lane registry",
    nullable: true
  },
  {
    field: "secondary_lanes",
    sourceTable: "canonical_jobs",
    sourceColumn: "secondary_lanes",
    producerStage: "laneRouter.ts",
    transformation: "Secondary semantic lane keys meeting per-lane thresholds with positive evidence (no negative exclusions)",
    nullable: false
  },
  {
    field: "lane_confidence",
    sourceTable: "canonical_jobs",
    sourceColumn: "lane_confidence",
    producerStage: "laneRouter.ts",
    transformation: "High / Medium / Low / None confidence derived from semantic score band relative to lane threshold",
    nullable: false
  },
  {
    field: "priority_score",
    sourceTable: "evaluation_queue",
    sourceColumn: "priority_score",
    producerStage: "explanationQueueEnqueuer.ts",
    transformation: "Queue priority derived from deterministic_match_score when available, otherwise semantic_score fallback",
    nullable: false
  },
  {
    field: "deterministic_match_score",
    sourceTable: "canonical_jobs",
    sourceColumn: "deterministic_match_score",
    producerStage: "deterministicMatcher.ts",
    transformation: "Weighted requirement-to-profile match score (0-100)",
    nullable: true
  },
  {
    field: "deterministic_match_coverage",
    sourceTable: "canonical_jobs",
    sourceColumn: "deterministic_match_coverage",
    producerStage: "deterministicMatcher.ts",
    transformation: "Percentage of validated requirements with evidence matches",
    nullable: true
  },
  {
    field: "processing_state",
    sourceTable: "canonical_jobs",
    sourceColumn: "processing_state",
    producerStage: "State Machine",
    transformation: "Current lifecycle state enum (preferred)",
    nullable: false
  },
  {
    field: "processing_status",
    sourceTable: "canonical_jobs",
    sourceColumn: "processing_status",
    producerStage: "State Machine",
    transformation: "Legacy lifecycle state enum (superseded by processing_state)",
    nullable: false
  },
  {
    field: "recommendation_eligibility",
    sourceTable: "canonical_jobs",
    sourceColumn: "recommendation_eligibility",
    producerStage: "recommendationDecider.ts",
    transformation: "Deterministic eligibility: ELIGIBLE / VERIFY / INELIGIBLE",
    nullable: true
  },
  {
    field: "recommendation_outcome",
    sourceTable: "canonical_jobs",
    sourceColumn: "recommendation_outcome",
    producerStage: "recommendationDecider.ts",
    transformation: "Deterministic outcome: PRIORITY / REVIEW / TRACK / SKIP",
    nullable: true
  },
  {
    field: "recommendation_requirement_score",
    sourceTable: "canonical_jobs",
    sourceColumn: "recommendation_requirement_score",
    producerStage: "recommendationDecider.ts",
    transformation: "Deterministic requirement score (0-1) derived from deterministic_match_score",
    nullable: true
  },
  {
    field: "recommendation_coverage_score",
    sourceTable: "canonical_jobs",
    sourceColumn: "recommendation_coverage_score",
    producerStage: "recommendationDecider.ts",
    transformation: "Deterministic coverage score (0-1) derived from deterministic_match_coverage",
    nullable: true
  },
  {
    field: "recommendation_evidence_completeness",
    sourceTable: "canonical_jobs",
    sourceColumn: "recommendation_evidence_completeness",
    producerStage: "recommendationDecider.ts",
    transformation: "Deterministic evidence completeness (0-1) from workability facts completeness",
    nullable: true
  },
  {
    field: "recommendation_decided_at",
    sourceTable: "canonical_jobs",
    sourceColumn: "recommendation_decided_at",
    producerStage: "recommendationDecider.ts",
    transformation: "Timestamp when deterministic outcome was last updated",
    nullable: true
  },
  {
    field: "nd_friendly_score",
    sourceTable: "ai_evaluations",
    sourceColumn: "nd_friendly_score",
    producerStage: "evaluate_queue.ts",
    transformation: "0-100 score based on autonomy, async comms, sensory load",
    nullable: true
  },
  {
    field: "politics_stress_score",
    sourceTable: "ai_evaluations",
    sourceColumn: "politics_stress_score",
    producerStage: "evaluate_queue.ts",
    transformation: "0-100 score based on matrix bureaucracy and stakeholder chaos",
    nullable: true
  },
  {
    field: "sensory_overload_index",
    sourceTable: "ai_evaluations",
    sourceColumn: "full_evaluation_payload",
    producerStage: "evaluate_queue.ts",
    transformation: "JSON payload sensory_overload_index",
    nullable: true
  },
  {
    field: "next_action",
    sourceTable: "ai_evaluations",
    sourceColumn: "next_action",
    producerStage: "evaluate_queue.ts",
    transformation: "PRIORITY_APPLY / APPLY_AFTER_VERIFICATION / LOW_STRATEGIC_VALUE / REJECTED",
    nullable: true
  },
  {
    field: "strategic_value",
    sourceTable: "ai_evaluations",
    sourceColumn: "strategic_value",
    producerStage: "evaluate_queue.ts",
    transformation: "Executive summary of role value for candidate",
    nullable: true
  },
  {
    field: "recommended_cv_version",
    sourceTable: "ai_evaluations",
    sourceColumn: "recommended_cv_version",
    producerStage: "evaluate_queue.ts",
    transformation: "Matched specialized CV template name",
    nullable: true
  },
  {
    field: "evaluation_summary",
    sourceTable: "ai_evaluations",
    sourceColumn: "full_evaluation_payload",
    producerStage: "evaluate_queue.ts",
    transformation: "JSON payload evaluation_summary",
    nullable: true
  },
  {
    field: "eval_provider",
    sourceTable: "ai_evaluations",
    sourceColumn: "provider",
    producerStage: "evaluate_queue.ts",
    transformation: "Provider used for latest version evaluation",
    nullable: true
  },
  {
    field: "eval_is_fallback",
    sourceTable: "ai_evaluations",
    sourceColumn: "is_fallback",
    producerStage: "evaluate_queue.ts",
    transformation: "Whether provider fallback was used",
    nullable: true
  },
  {
    field: "version_mismatch",
    sourceTable: "ai_evaluations",
    sourceColumn: "job_version_id",
    producerStage: "v_canonical_shortlist",
    transformation: "True when evaluated canonical status has no evaluation for displayed version",
    nullable: false
  },
  {
    field: "observed_at",
    sourceTable: "canonical_jobs",
    sourceColumn: "created_at",
    producerStage: "normalize.ts",
    transformation: "ISO timestamp of initial observation",
    nullable: false
  },
  {
    field: "evaluated_at",
    sourceTable: "ai_evaluations",
    sourceColumn: "evaluated_at",
    producerStage: "evaluate_queue.ts",
    transformation: "ISO timestamp of completed LLM evaluation",
    nullable: true
  },
  {
    field: "lane_matches",
    sourceTable: "ai_evaluations",
    sourceColumn: "lane_matches",
    producerStage: "evaluate_queue.ts",
    transformation: "Persisted lane match evidence",
    nullable: true
  },
  {
    field: "workability_facts",
    sourceTable: "ai_evaluations",
    sourceColumn: "workability_facts",
    producerStage: "hardGate.ts -> evaluate_queue.ts",
    transformation: "Version-pinned workability facts",
    nullable: true
  },
  {
    field: "queue_status",
    sourceTable: "evaluation_queue",
    sourceColumn: "status",
    producerStage: "explanationQueueEnqueuer.ts",
    transformation: "Latest queue state for displayed version",
    nullable: true
  },
  {
    field: "latest_match_run_id",
    sourceTable: "canonical_jobs",
    sourceColumn: "latest_match_run_id",
    producerStage: "deterministicMatcher.ts",
    transformation: "Latest deterministic matching run id for displayed job version",
    nullable: true
  },
  {
    field: "cv_document_run_id",
    sourceTable: "document_runs",
    sourceColumn: "id",
    producerStage: "generate_cv.ts -> provenance.ts",
    transformation: "Latest completed CV document run for displayed job version",
    nullable: true
  },
  {
    field: "cover_letter_document_run_id",
    sourceTable: "document_runs",
    sourceColumn: "id",
    producerStage: "generate_cover_letter.ts -> provenance.ts",
    transformation: "Latest completed cover letter run for displayed job version",
    nullable: true
  },
  {
    field: "document_ready",
    sourceTable: "document_runs",
    sourceColumn: "id",
    producerStage: "v_canonical_shortlist",
    transformation: "True when CV or cover letter provenance exists for displayed version",
    nullable: false
  }
];

export function generateFieldLineageMarkdown(): string {
  let md = "# Shortlist Read Model Field Lineage\n\n";
  md += "| Shortlist Field | Database Table | DB Column | Producer | Transformation | Nullable |\n";
  md += "|---|---|---|---|---|---|\n";
  for (const entry of SHORTLIST_FIELD_LINEAGE) {
    md += `| \`${entry.field}\` | \`${entry.sourceTable}\` | \`${entry.sourceColumn}\` | \`${entry.producerStage}\` | ${entry.transformation} | ${entry.nullable ? "Yes" : "No"} |\n`;
  }
  return md;
}
