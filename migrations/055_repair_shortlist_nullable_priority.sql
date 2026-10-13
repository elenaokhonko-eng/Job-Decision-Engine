-- Migration 055: Deterministically repair v_canonical_shortlist and v_canonical_shortlist_scoped
-- to preserve nullable priority_score (unknown priority remains NULL, not 0.0).
--
-- Migration 052 used a regex that did not match PostgreSQL's decompiled
-- 0.0::double precision typecast on existing databases. This migration explicitly
-- recreates the canonical shortlist views using current_schema() isolation.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.views WHERE table_schema = current_schema() AND table_name = 'v_canonical_shortlist_scoped') THEN
    EXECUTE format('DROP VIEW %I.v_canonical_shortlist_scoped CASCADE', current_schema());
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.views WHERE table_schema = current_schema() AND table_name = 'v_canonical_shortlist') THEN
    EXECUTE format('DROP VIEW %I.v_canonical_shortlist CASCADE', current_schema());
  END IF;
END $$;

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
  vq.priority_score AS priority_score,
  c.deterministic_match_score,
  c.deterministic_match_coverage,
  COALESCE(c.processing_state, c.processing_status) AS processing_state,
  COALESCE(c.processing_state, c.processing_status) AS processing_status,
  c.recommendation_eligibility,
  c.recommendation_outcome,
  c.recommendation_requirement_score,
  c.recommendation_coverage_score,
  c.recommendation_evidence_completeness,
  c.recommendation_decided_at,
  (ve.full_evaluation_payload->>'nd_friendly_score')::numeric AS nd_friendly_score,
  (ve.full_evaluation_payload->>'politics_stress_score')::numeric AS politics_stress_score,
  (ve.full_evaluation_payload->>'sensory_overload_index')::numeric AS sensory_overload_index,
  ve.full_evaluation_payload->>'next_action' AS next_action,
  ve.full_evaluation_payload->>'strategic_value' AS strategic_value,
  ve.full_evaluation_payload->>'recommended_cv_version' AS recommended_cv_version,
  ve.full_evaluation_payload->>'evaluation_summary' AS evaluation_summary,
  ve.eval_provider,
  ve.eval_is_fallback,
  (ve.eval_id IS NULL AND COALESCE(c.processing_state, c.processing_status) = 'AI_EVALUATED') AS version_mismatch,
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
WHERE COALESCE(c.processing_state, c.processing_status) NOT IN ('HARD_REJECTED', 'MANUALLY_REMOVED');

CREATE OR REPLACE VIEW v_canonical_shortlist_scoped AS
SELECT
  c.workspace_id,
  s.*,
  CASE
    WHEN blocked.blocked_task_count > 0 THEN 'BLOCKED_DEPENDENCY'
    WHEN s.gate_status = 'PASS' AND (
      active_profile.id IS NULL
      OR target_jv.active_requirement_set_id IS NULL
      OR mr.id IS NULL
      OR mr.status <> 'COMPLETED'
      OR mr.canonical_job_id IS DISTINCT FROM c.id
      OR mr.job_version_id IS DISTINCT FROM target_jv.id
      OR mr.profile_version_id IS DISTINCT FROM active_profile.id
      OR mr.requirement_set_id IS DISTINCT FROM target_jv.active_requirement_set_id
      OR mr.job_content_hash IS DISTINCT FROM target_jv.content_hash
      OR mr.context_fingerprint IS NULL
    ) THEN 'MATCH_STALE'
    WHEN s.gate_status = 'PASS' AND (
      dd.id IS NULL
      OR dd.canonical_job_id IS DISTINCT FROM c.id
      OR dd.job_version_id IS DISTINCT FROM target_jv.id
      OR dd.match_run_id IS DISTINCT FROM mr.id
      OR dd.context_fingerprint IS NULL
    ) THEN 'DECISION_STALE'
    WHEN s.gate_status = 'PASS' AND latest_eval.id IS NULL THEN 'EVALUATION_MISSING'
    WHEN s.gate_status = 'PASS' AND (
      latest_eval.profile_version_id IS DISTINCT FROM active_profile.id
      OR latest_eval.canonical_job_id IS DISTINCT FROM c.id
      OR latest_eval.job_version_id IS DISTINCT FROM target_jv.id
      OR latest_eval.match_run_id IS DISTINCT FROM mr.id
      OR latest_eval.deterministic_decision_id IS DISTINCT FROM dd.id
      OR latest_eval.job_content_hash IS DISTINCT FROM target_jv.content_hash
      OR latest_eval.context_fingerprint IS NULL
    ) THEN 'EVALUATION_STALE'
    WHEN s.version_mismatch THEN 'EVALUATION_STALE'
    ELSE 'CURRENT_OR_NOT_APPLICABLE'
  END AS current_artifact_status,
  CASE
    WHEN blocked.blocked_task_count > 0 THEN blocked.blocked_reason
    WHEN s.gate_status = 'PASS' AND active_profile.id IS NULL THEN 'NO_ACTIVE_PROFILE'
    WHEN s.gate_status = 'PASS' AND target_jv.active_requirement_set_id IS NULL THEN 'NO_ACTIVE_REQUIREMENT_SET'
    WHEN s.gate_status = 'PASS' AND mr.id IS NULL THEN 'NO_CURRENT_MATCH_RUN'
    WHEN s.gate_status = 'PASS' AND mr.status <> 'COMPLETED' THEN 'MATCH_RUN_NOT_COMPLETED'
    WHEN s.gate_status = 'PASS' AND mr.canonical_job_id IS DISTINCT FROM c.id THEN 'MATCH_CANONICAL_JOB_STALE'
    WHEN s.gate_status = 'PASS' AND mr.job_version_id IS DISTINCT FROM target_jv.id THEN 'MATCH_JOB_VERSION_STALE'
    WHEN s.gate_status = 'PASS' AND mr.profile_version_id IS DISTINCT FROM active_profile.id THEN 'MATCH_PROFILE_VERSION_STALE'
    WHEN s.gate_status = 'PASS' AND mr.requirement_set_id IS DISTINCT FROM target_jv.active_requirement_set_id THEN 'MATCH_REQUIREMENT_SET_STALE'
    WHEN s.gate_status = 'PASS' AND mr.job_content_hash IS DISTINCT FROM target_jv.content_hash THEN 'MATCH_JOB_CONTENT_STALE'
    WHEN s.gate_status = 'PASS' AND mr.context_fingerprint IS NULL THEN 'MATCH_CONTEXT_UNPROVABLE'
    WHEN s.gate_status = 'PASS' AND dd.id IS NULL THEN 'NO_CURRENT_DETERMINISTIC_DECISION'
    WHEN s.gate_status = 'PASS' AND dd.canonical_job_id IS DISTINCT FROM c.id THEN 'DECISION_CANONICAL_JOB_STALE'
    WHEN s.gate_status = 'PASS' AND dd.job_version_id IS DISTINCT FROM target_jv.id THEN 'DECISION_JOB_VERSION_STALE'
    WHEN s.gate_status = 'PASS' AND dd.match_run_id IS DISTINCT FROM mr.id THEN 'DECISION_MATCH_RUN_STALE'
    WHEN s.gate_status = 'PASS' AND dd.context_fingerprint IS NULL THEN 'DECISION_CONTEXT_UNPROVABLE'
    WHEN s.gate_status = 'PASS' AND latest_eval.id IS NULL THEN 'NO_CURRENT_AI_EVALUATION'
    WHEN s.gate_status = 'PASS' AND latest_eval.context_fingerprint IS NULL THEN 'EVALUATION_CONTEXT_UNPROVABLE'
    WHEN s.version_mismatch THEN 'NO_CURRENT_EVALUATION_FOR_DISPLAYED_VERSION'
    ELSE NULL
  END AS current_artifact_reason,
  blocked.blocked_task_count
FROM canonical_jobs c
JOIN v_canonical_shortlist s
  ON s.canonical_job_id = c.id
LEFT JOIN LATERAL (
  SELECT jv.id, jv.active_requirement_set_id, jv.content_hash
  FROM job_versions jv
  WHERE jv.workspace_id = c.workspace_id
    AND jv.id = s.job_version_id::uuid
  LIMIT 1
) target_jv ON TRUE
LEFT JOIN LATERAL (
  SELECT pv.id
  FROM profile_versions pv
  WHERE pv.workspace_id = c.workspace_id
    AND pv.status = 'ACTIVE'
  ORDER BY pv.created_at DESC
  LIMIT 1
) active_profile ON TRUE
LEFT JOIN LATERAL (
  SELECT
    mr_sub.id,
    mr_sub.status,
    mr_sub.canonical_job_id,
    mr_sub.job_version_id,
    mr_sub.profile_version_id,
    mr_sub.requirement_set_id,
    mr_sub.job_content_hash,
    mr_sub.context_fingerprint
  FROM match_runs mr_sub
  WHERE mr_sub.workspace_id = c.workspace_id
    AND mr_sub.id = c.latest_match_run_id
  LIMIT 1
) mr ON TRUE
LEFT JOIN LATERAL (
  SELECT
    dd_sub.id,
    dd_sub.canonical_job_id,
    dd_sub.job_version_id,
    dd_sub.match_run_id,
    dd_sub.context_fingerprint
  FROM deterministic_decisions dd_sub
  WHERE dd_sub.workspace_id = c.workspace_id
    AND dd_sub.id = c.latest_deterministic_decision_id
  LIMIT 1
) dd ON TRUE
LEFT JOIN LATERAL (
  SELECT ae.id, ae.canonical_job_id, ae.job_version_id,
         ae.profile_version_id, ae.match_run_id,
         ae.deterministic_decision_id, ae.job_content_hash,
         ae.context_fingerprint
  FROM ai_evaluations ae
  WHERE ae.workspace_id = c.workspace_id
    AND ae.canonical_job_id = c.id
    AND ae.job_version_id = s.job_version_id::uuid
  ORDER BY ae.evaluated_at DESC, ae.id DESC
  LIMIT 1
) latest_eval ON TRUE
LEFT JOIN LATERAL (
  SELECT
    COUNT(*)::int AS blocked_task_count,
    MAX(pt.blocked_reason) AS blocked_reason
  FROM pipeline_tasks pt
  WHERE pt.workspace_id = c.workspace_id
    AND pt.status = 'BLOCKED_DEPENDENCY'
    AND (
      pt.payload->>'canonical_job_id' = c.id::text
      OR pt.payload->>'job_version_id' = s.job_version_id::text
    )
) blocked ON TRUE;
