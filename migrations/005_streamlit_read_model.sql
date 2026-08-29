-- Migration 005: Streamlit read model
-- Creates v_canonical_shortlist, the stable read view that Streamlit consumes.
--
-- Design invariants (AGENTS.md):
--   - gate_status is sourced from gate_decisions; no default PASS is injected
--   - ai_evaluation is matched on job_version_id (latest version) to avoid stale pairings
--   - A version_mismatch flag is exposed so the UI can warn when evaluation is stale
--   - This view is additive: it does not modify any existing table

-- Drop and recreate so the definition is always current
DROP VIEW IF EXISTS v_canonical_shortlist;

CREATE OR REPLACE VIEW v_canonical_shortlist AS
WITH latest_version AS (
  -- Latest job version per canonical job
  SELECT DISTINCT ON (canonical_job_id)
    id                     AS version_id,
    canonical_job_id,
    description_text,
    observed_at
  FROM job_versions
  ORDER BY canonical_job_id, observed_at DESC
),
latest_gate AS (
  -- Latest gate decision per canonical job (no default PASS)
  SELECT DISTINCT ON (canonical_job_id)
    canonical_job_id,
    decision                AS gate_status,
    rejection_codes,
    evidence_quotes         AS gate_evidence_quotes,
    created_at              AS gated_at
  FROM gate_decisions
  ORDER BY canonical_job_id, created_at DESC
),
latest_eval AS (
  -- Latest AI evaluation per canonical job, matched to version
  SELECT DISTINCT ON (canonical_job_id)
    canonical_job_id,
    job_version_id          AS eval_version_id,
    lane_matches,
    workability_facts,
    full_evaluation_payload,
    provider                AS eval_provider,
    is_fallback,
    evaluated_at,
    (full_evaluation_payload->>'nd_score')::numeric           AS nd_friendly_score,
    (full_evaluation_payload->>'nd_friendly_score')::numeric  AS nd_score_alt,
    full_evaluation_payload->>'next_action'                   AS next_action,
    full_evaluation_payload->>'strategic_value'               AS strategic_value,
    full_evaluation_payload->>'recommended_cv_version'        AS recommended_cv_version,
    full_evaluation_payload->>'evaluation_summary'            AS evaluation_summary
  FROM ai_evaluations
  ORDER BY canonical_job_id, evaluated_at DESC
)
SELECT
  -- Identity
  c.id                                              AS canonical_job_id,
  lv.version_id                                     AS job_version_id,
  c.normalized_title                                AS title,
  c.company_name                                    AS company,
  c.canonical_url,
  c.location_normalized                             AS location,
  c.workplace_type_normalized                       AS workplace_type,

  -- Gate
  COALESCE(lg.gate_status, 'NOT_GATED')            AS gate_status,
  lg.rejection_codes,
  lg.gate_evidence_quotes,
  lg.gated_at,

  -- Lane
  c.primary_lane,
  c.secondary_lanes,
  c.lane_confidence,
  c.lane_evidence,

  -- Pipeline state
  c.processing_status,

  -- Evaluation
  le.eval_version_id,
  -- Version mismatch: evaluation is for an older version
  (le.eval_version_id IS NOT NULL AND le.eval_version_id <> lv.version_id) AS version_mismatch,
  COALESCE(le.nd_friendly_score, le.nd_score_alt, 0) AS nd_friendly_score,
  le.next_action,
  le.strategic_value,
  le.recommended_cv_version,
  le.evaluation_summary,
  le.eval_provider,
  le.is_fallback                                    AS eval_is_fallback,
  le.evaluated_at,
  le.lane_matches,
  le.workability_facts,

  -- Scoring (from evaluation queue for priority)
  eq.priority_score,
  eq.status                                         AS queue_status,

  -- Timestamps
  lv.observed_at,
  c.updated_at
FROM canonical_jobs c
LEFT JOIN latest_version lv  ON lv.canonical_job_id = c.id
LEFT JOIN latest_gate   lg   ON lg.canonical_job_id = c.id
LEFT JOIN latest_eval   le   ON le.canonical_job_id = c.id
LEFT JOIN (
  SELECT DISTINCT ON (canonical_job_id)
    canonical_job_id, priority_score, status
  FROM evaluation_queue
  ORDER BY canonical_job_id, enqueued_at DESC
) eq ON eq.canonical_job_id = c.id
WHERE c.processing_status NOT IN ('MANUALLY_REMOVED', 'HARD_REJECTED')
;
