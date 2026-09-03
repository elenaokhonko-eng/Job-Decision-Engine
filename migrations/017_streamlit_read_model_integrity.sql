-- Migration 017: Streamlit read model integrity and rejected-job audit view
--
-- Goals:
-- 1) Keep Streamlit on stable read-model views (no ad-hoc legacy joins).
-- 2) Expose deterministic matching and document provenance summary columns.
-- 3) Provide a canonical rejected/removed audit view for UI inspection.

BEGIN;

DROP VIEW IF EXISTS shortlist_view CASCADE;
DROP VIEW IF EXISTS v_canonical_shortlist CASCADE;
DROP VIEW IF EXISTS v_rejected_jobs_audit CASCADE;

CREATE OR REPLACE VIEW v_canonical_shortlist AS
WITH target_versions AS (
  SELECT
    c.id AS canonical_job_id,
    COALESCE(c.latest_job_version_id, lv.id) AS version_id,
    COALESCE(jv_direct.description_text, lv.description_text) AS description_text,
    COALESCE(jv_direct.observed_at, lv.observed_at, c.created_at) AS observed_at
  FROM canonical_jobs c
  LEFT JOIN job_versions jv_direct ON jv_direct.id = c.latest_job_version_id
  LEFT JOIN LATERAL (
    SELECT id, description_text, observed_at
    FROM job_versions
    WHERE canonical_job_id = c.id
    ORDER BY observed_at DESC
    LIMIT 1
  ) lv ON TRUE
),
latest_observations AS (
  SELECT DISTINCT ON (rjo.job_version_id)
    rjo.job_version_id,
    rjo.source_name,
    rjo.retrieved_at
  FROM raw_job_observations rjo
  WHERE rjo.job_version_id IS NOT NULL
  ORDER BY rjo.job_version_id, rjo.retrieved_at DESC
),
version_gates AS (
  SELECT DISTINCT ON (canonical_job_id, job_version_id)
    canonical_job_id,
    job_version_id,
    decision AS gate_status,
    rejection_codes,
    evidence_quotes,
    gate_version,
    created_at
  FROM gate_decisions
  ORDER BY canonical_job_id, job_version_id, created_at DESC
),
version_evaluations AS (
  SELECT DISTINCT ON (canonical_job_id, job_version_id)
    id AS eval_id,
    canonical_job_id,
    job_version_id,
    full_evaluation_payload,
    lane_matches,
    workability_facts,
    provider AS eval_provider,
    model AS eval_model,
    attempt AS eval_attempt,
    is_fallback AS eval_is_fallback,
    degraded_state AS eval_degraded,
    evaluated_at
  FROM ai_evaluations
  ORDER BY canonical_job_id, job_version_id, evaluated_at DESC
),
version_queue AS (
  SELECT DISTINCT ON (canonical_job_id, job_version_id)
    canonical_job_id,
    job_version_id,
    status AS queue_status,
    priority_score,
    attempt_count,
    last_error,
    available_at,
    enqueued_at,
    updated_at
  FROM evaluation_queue
  ORDER BY canonical_job_id, job_version_id, COALESCE(updated_at, enqueued_at, available_at, NOW()) DESC
),
latest_cv_documents AS (
  SELECT DISTINCT ON (dr.canonical_job_id, dr.job_version_id)
    dr.canonical_job_id,
    dr.job_version_id,
    dr.id AS cv_document_run_id
  FROM document_runs dr
  WHERE dr.document_type = 'CV' AND dr.status = 'COMPLETED'
  ORDER BY dr.canonical_job_id, dr.job_version_id, dr.completed_at DESC NULLS LAST, dr.created_at DESC
),
latest_cover_letters AS (
  SELECT DISTINCT ON (dr.canonical_job_id, dr.job_version_id)
    dr.canonical_job_id,
    dr.job_version_id,
    dr.id AS cover_letter_document_run_id
  FROM document_runs dr
  WHERE dr.document_type = 'COVER_LETTER' AND dr.status = 'COMPLETED'
  ORDER BY dr.canonical_job_id, dr.job_version_id, dr.completed_at DESC NULLS LAST, dr.created_at DESC
)
SELECT
  c.id AS canonical_job_id,
  tv.version_id AS job_version_id,
  COALESCE(c.normalized_title, 'Unknown Title') AS title,
  COALESCE(c.company_name, 'Unknown Company') AS company,
  c.canonical_url,
  COALESCE(lo.source_name, 'UNKNOWN') AS source,
  COALESCE(c.location, c.location_summary, 'Unknown') AS location,
  COALESCE(c.workplace_type, 'UNKNOWN') AS workplace_type,
  COALESCE(c.employment_type, 'UNKNOWN') AS employment_type,
  tv.description_text AS description,
  COALESCE(vg.gate_status, 'NEEDS_VERIFICATION') AS gate_status,
  vg.rejection_codes,
  vg.evidence_quotes AS gate_evidence_quotes,
  c.primary_lane,
  c.secondary_lanes,
  c.lane_confidence,
  COALESCE(vq.priority_score, 0.0) AS priority_score,
  c.deterministic_match_score,
  c.deterministic_match_coverage,
  c.processing_status,
  (ve.full_evaluation_payload->>'nd_friendly_score')::numeric AS nd_friendly_score,
  (ve.full_evaluation_payload->>'politics_stress_score')::numeric AS politics_stress_score,
  (ve.full_evaluation_payload->>'sensory_overload_index')::numeric AS sensory_overload_index,
  ve.full_evaluation_payload->>'next_action' AS next_action,
  ve.full_evaluation_payload->>'strategic_value' AS strategic_value,
  ve.full_evaluation_payload->>'recommended_cv_version' AS recommended_cv_version,
  ve.full_evaluation_payload->>'evaluation_summary' AS evaluation_summary,
  ve.eval_provider,
  ve.eval_is_fallback,
  (ve.eval_id IS NULL AND c.processing_status = 'AI_EVALUATED') AS version_mismatch,
  tv.observed_at,
  ve.evaluated_at,
  ve.lane_matches,
  ve.workability_facts,
  vq.queue_status,
  c.latest_match_run_id,
  cv.cv_document_run_id,
  cl.cover_letter_document_run_id,
  ((cv.cv_document_run_id IS NOT NULL) OR (cl.cover_letter_document_run_id IS NOT NULL)) AS document_ready
FROM canonical_jobs c
JOIN target_versions tv ON tv.canonical_job_id = c.id
LEFT JOIN latest_observations lo ON lo.job_version_id = tv.version_id
LEFT JOIN version_gates vg ON vg.canonical_job_id = c.id AND vg.job_version_id = tv.version_id
LEFT JOIN version_evaluations ve ON ve.canonical_job_id = c.id AND ve.job_version_id = tv.version_id
LEFT JOIN version_queue vq ON vq.canonical_job_id = c.id AND vq.job_version_id = tv.version_id
LEFT JOIN latest_cv_documents cv ON cv.canonical_job_id = c.id AND cv.job_version_id = tv.version_id
LEFT JOIN latest_cover_letters cl ON cl.canonical_job_id = c.id AND cl.job_version_id = tv.version_id
WHERE c.processing_status NOT IN ('HARD_REJECTED', 'MANUALLY_REMOVED');

CREATE OR REPLACE VIEW v_rejected_jobs_audit AS
WITH target_versions AS (
  SELECT
    c.id AS canonical_job_id,
    COALESCE(c.latest_job_version_id, lv.id) AS version_id,
    COALESCE(jv_direct.description_text, lv.description_text) AS description_text,
    COALESCE(jv_direct.observed_at, lv.observed_at, c.created_at) AS observed_at
  FROM canonical_jobs c
  LEFT JOIN job_versions jv_direct ON jv_direct.id = c.latest_job_version_id
  LEFT JOIN LATERAL (
    SELECT id, description_text, observed_at
    FROM job_versions
    WHERE canonical_job_id = c.id
    ORDER BY observed_at DESC
    LIMIT 1
  ) lv ON TRUE
),
latest_observations AS (
  SELECT DISTINCT ON (rjo.job_version_id)
    rjo.job_version_id,
    rjo.source_name,
    rjo.retrieved_at
  FROM raw_job_observations rjo
  WHERE rjo.job_version_id IS NOT NULL
  ORDER BY rjo.job_version_id, rjo.retrieved_at DESC
),
version_gates AS (
  SELECT DISTINCT ON (canonical_job_id, job_version_id)
    canonical_job_id,
    job_version_id,
    decision AS gate_status,
    rejection_codes,
    evidence_quotes,
    created_at
  FROM gate_decisions
  ORDER BY canonical_job_id, job_version_id, created_at DESC
),
version_evaluations AS (
  SELECT DISTINCT ON (canonical_job_id, job_version_id)
    canonical_job_id,
    job_version_id,
    full_evaluation_payload,
    evaluated_at
  FROM ai_evaluations
  ORDER BY canonical_job_id, job_version_id, evaluated_at DESC
)
SELECT
  c.id,
  tv.version_id AS job_version_id,
  COALESCE(c.normalized_title, 'Unknown Title') AS title,
  COALESCE(c.company_name, 'Unknown Company') AS company,
  c.canonical_url AS careers_portal_url,
  COALESCE(lo.source_name, 'UNKNOWN') AS source,
  c.processing_status AS status,
  c.rejection_reason,
  COALESCE(vg.gate_status, 'NEEDS_VERIFICATION') AS gate_status,
  vg.rejection_codes,
  vg.evidence_quotes AS gate_evidence_quotes,
  tv.description_text AS description,
  (ve.full_evaluation_payload->>'nd_friendly_score')::numeric AS nd_friendly_score,
  (ve.full_evaluation_payload->>'politics_stress_score')::numeric AS politics_stress_score,
  (ve.full_evaluation_payload->>'sensory_overload_index')::numeric AS sensory_overload_index,
  tv.observed_at::text AS "postedDate"
FROM canonical_jobs c
JOIN target_versions tv ON tv.canonical_job_id = c.id
LEFT JOIN latest_observations lo ON lo.job_version_id = tv.version_id
LEFT JOIN version_gates vg ON vg.canonical_job_id = c.id AND vg.job_version_id = tv.version_id
LEFT JOIN version_evaluations ve ON ve.canonical_job_id = c.id AND ve.job_version_id = tv.version_id
WHERE c.processing_status IN ('HARD_REJECTED', 'MANUALLY_REMOVED');

CREATE OR REPLACE VIEW shortlist_view AS
SELECT * FROM v_canonical_shortlist;

COMMIT;
