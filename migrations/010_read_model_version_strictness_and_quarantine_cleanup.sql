-- Migration 010: Strict version-pinned read model and cleanup of fabricated migration-008 placeholders
--
-- Goals:
-- 1) Quarantine queue rows that were bound to synthetic migration-008 placeholder versions.
-- 2) Rebuild v_canonical_shortlist to join gate/eval/queue records by the displayed job_version_id.
-- 3) Use canonical_jobs.latest_job_version_id as the primary version pointer.
-- 4) Detect version_mismatch against AI_EVALUATED runtime status.

-- Ensure quarantine table exists (idempotent safety for upgrades from partial environments)
CREATE TABLE IF NOT EXISTS quarantined_queue_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_queue_id UUID,
    canonical_job_id UUID,
    job_version_id UUID,
    quarantine_reason TEXT NOT NULL,
    raw_record_payload JSONB,
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Move queue rows that point to fabricated placeholder versions from migration 008 into quarantine.
-- This preserves the original queue payload and removes misleading synthetic version usage.
INSERT INTO quarantined_queue_records (
    original_queue_id,
    canonical_job_id,
    job_version_id,
    quarantine_reason,
    raw_record_payload
)
SELECT
    eq.id,
    eq.canonical_job_id,
    eq.job_version_id,
    'Queue row bound to synthetic migration-008 placeholder version',
    to_jsonb(eq)
FROM evaluation_queue eq
JOIN job_versions jv ON jv.id = eq.job_version_id
WHERE jv.description_text = 'Quarantined record description recovered during migration 008.'
  AND jv.content_hash LIKE 'unlinked_version_hash_%'
  AND NOT EXISTS (
    SELECT 1
    FROM quarantined_queue_records qq
    WHERE qq.original_queue_id = eq.id
      AND qq.quarantine_reason = 'Queue row bound to synthetic migration-008 placeholder version'
  );

DELETE FROM evaluation_queue eq
USING job_versions jv
WHERE eq.job_version_id = jv.id
  AND jv.description_text = 'Quarantined record description recovered during migration 008.'
  AND jv.content_hash LIKE 'unlinked_version_hash_%';

-- Rebuild read model with strict version pinning.
DROP VIEW IF EXISTS shortlist_view CASCADE;
DROP VIEW IF EXISTS v_canonical_shortlist CASCADE;

CREATE OR REPLACE VIEW v_canonical_shortlist AS
WITH target_versions AS (
  SELECT
    c.id AS canonical_job_id,
    COALESCE(c.latest_job_version_id, lv.id) AS version_id,
    COALESCE(jv_direct.description_text, lv.description_text) AS description_text,
    COALESCE(jv_direct.observed_at, lv.observed_at) AS observed_at
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
    unknown_fields,
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
  vq.queue_status
FROM canonical_jobs c
JOIN target_versions tv ON tv.canonical_job_id = c.id
LEFT JOIN latest_observations lo ON lo.job_version_id = tv.version_id
LEFT JOIN version_gates vg ON vg.canonical_job_id = c.id AND vg.job_version_id = tv.version_id
LEFT JOIN version_evaluations ve ON ve.canonical_job_id = c.id AND ve.job_version_id = tv.version_id
LEFT JOIN version_queue vq ON vq.canonical_job_id = c.id AND vq.job_version_id = tv.version_id
WHERE c.processing_status NOT IN ('HARD_REJECTED', 'MANUALLY_REMOVED');

CREATE OR REPLACE VIEW shortlist_view AS
SELECT * FROM v_canonical_shortlist;
