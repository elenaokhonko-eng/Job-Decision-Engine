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
    sourceTable: "ai_evaluations",
    sourceColumn: "lane_matches[0].lane",
    producerStage: "laneRouter.ts -> evaluate_queue.ts",
    transformation: "Semantic pre-score confirmed by LLM evaluation",
    nullable: true
  },
  {
    field: "secondary_lanes",
    sourceTable: "ai_evaluations",
    sourceColumn: "secondary_lanes",
    producerStage: "evaluate_queue.ts",
    transformation: "Array of secondary matching career lanes",
    nullable: false
  },
  {
    field: "lane_confidence",
    sourceTable: "ai_evaluations",
    sourceColumn: "lane_matches[0].confidence",
    producerStage: "evaluate_queue.ts",
    transformation: "High / Medium / Low evidence confidence",
    nullable: false
  },
  {
    field: "priority_score",
    sourceTable: "evaluation_queue",
    sourceColumn: "priority_score",
    producerStage: "laneRouter.ts",
    transformation: "Cosine similarity against target lane prototype vector",
    nullable: false
  },
  {
    field: "processing_status",
    sourceTable: "canonical_jobs",
    sourceColumn: "processing_status",
    producerStage: "State Machine",
    transformation: "Current lifecycle state enum",
    nullable: false
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
    producerStage: "evaluationBudgeter.ts",
    transformation: "Latest queue state for displayed version",
    nullable: true
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
