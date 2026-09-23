-- Migration 054: repair the rejected-job read models when earlier view migrations
-- were recorded as applied before the views were created.
--
-- This migration is intentionally additive and idempotent. It restores the base
-- audit view before recreating the workspace-scoped view consumed by API/UI code.
-- Qualify the canonical schema and dependencies so an upgrade test using a
-- temporary search path cannot create a view tied to that temporary schema.

CREATE OR REPLACE VIEW public.v_rejected_jobs_audit AS
WITH target_versions AS (
  SELECT
    c.id AS canonical_job_id,
    COALESCE(c.latest_job_version_id, lv.id) AS version_id,
    COALESCE(jv_direct.description_text, lv.description_text) AS description_text,
    COALESCE(jv_direct.observed_at, lv.observed_at, c.created_at) AS observed_at
  FROM public.canonical_jobs c
  LEFT JOIN public.job_versions jv_direct ON jv_direct.id = c.latest_job_version_id
  LEFT JOIN LATERAL (
    SELECT id, description_text, observed_at
    FROM public.job_versions
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
  FROM public.raw_job_observations rjo
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
  FROM public.gate_decisions
  ORDER BY canonical_job_id, job_version_id, created_at DESC
),
version_evaluations AS (
  SELECT DISTINCT ON (canonical_job_id, job_version_id)
    canonical_job_id,
    job_version_id,
    full_evaluation_payload,
    evaluated_at
  FROM public.ai_evaluations
  ORDER BY canonical_job_id, job_version_id, evaluated_at DESC
)
SELECT
  c.id,
  tv.version_id AS job_version_id,
  COALESCE(c.normalized_title, 'Unknown Title') AS title,
  COALESCE(c.company_name, 'Unknown Company') AS company,
  c.canonical_url AS careers_portal_url,
  COALESCE(lo.source_name, 'UNKNOWN') AS source,
  COALESCE(c.processing_state, c.processing_status) AS status,
  c.rejection_reason,
  COALESCE(vg.gate_status, 'NEEDS_VERIFICATION') AS gate_status,
  vg.rejection_codes,
  vg.evidence_quotes AS gate_evidence_quotes,
  tv.description_text AS description,
  (ve.full_evaluation_payload->>'nd_friendly_score')::numeric AS nd_friendly_score,
  (ve.full_evaluation_payload->>'politics_stress_score')::numeric AS politics_stress_score,
  (ve.full_evaluation_payload->>'sensory_overload_index')::numeric AS sensory_overload_index,
  tv.observed_at::text AS "postedDate"
FROM public.canonical_jobs c
JOIN target_versions tv ON tv.canonical_job_id = c.id
LEFT JOIN latest_observations lo ON lo.job_version_id = tv.version_id
LEFT JOIN version_gates vg ON vg.canonical_job_id = c.id AND vg.job_version_id = tv.version_id
LEFT JOIN version_evaluations ve ON ve.canonical_job_id = c.id AND ve.job_version_id = tv.version_id
WHERE COALESCE(c.processing_state, c.processing_status) IN ('HARD_REJECTED', 'MANUALLY_REMOVED');

CREATE OR REPLACE VIEW public.v_rejected_jobs_audit_scoped AS
SELECT c.workspace_id, r.*
FROM public.canonical_jobs c
JOIN public.v_rejected_jobs_audit r ON r.id = c.id;

COMMENT ON VIEW public.v_rejected_jobs_audit IS
  'Rejected and manually removed jobs with gate evidence for audit consumers.';
COMMENT ON VIEW public.v_rejected_jobs_audit_scoped IS
  'Stable workspace-scoped rejected-job audit read model.';
