-- Migration 009: Canonical Read Model, Quarantine Table & Evaluation Attempts
--
-- Invariants:
-- 1. Unresolvable/orphaned queue records are archived into quarantined_queue_records preserving original data.
-- 2. evaluation_attempts records detailed retry and telemetry history per version.
-- 3. v_canonical_shortlist joins latest_job_version_id directly, incorporates source board, and detects version mismatches.

-- 1. Explicit observation-to-version linkage used by normalization and the read model.
ALTER TABLE raw_job_observations
  ADD COLUMN IF NOT EXISTS job_version_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'raw_job_observations'
      AND constraint_name = 'fk_raw_observation_job_version'
  ) THEN
    ALTER TABLE raw_job_observations
      ADD CONSTRAINT fk_raw_observation_job_version
      FOREIGN KEY (job_version_id) REFERENCES job_versions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_raw_observations_job_version
  ON raw_job_observations(job_version_id);

-- 2. Quarantine table for unresolved queue records
CREATE TABLE IF NOT EXISTS quarantined_queue_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_queue_id UUID,
    canonical_job_id UUID,
    job_version_id UUID,
    quarantine_reason TEXT NOT NULL,
    raw_record_payload JSONB,
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Evaluation attempts tracking table
CREATE TABLE IF NOT EXISTS evaluation_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
    job_version_id UUID NOT NULL REFERENCES job_versions(id) ON DELETE CASCADE,
    attempt_number INT NOT NULL DEFAULT 1,
    provider VARCHAR(50) NOT NULL,
    model VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL,
    error_message TEXT,
    latency_ms INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eval_attempts_job_ver ON evaluation_attempts(canonical_job_id, job_version_id);

-- 4. Rebuild v_canonical_shortlist and shortlist_view
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
    rjo.source_name
  FROM raw_job_observations rjo
  WHERE rjo.job_version_id IS NOT NULL
  ORDER BY rjo.job_version_id, rjo.retrieved_at DESC
),
latest_gates AS (
  SELECT DISTINCT ON (canonical_job_id)
    canonical_job_id,
    decision AS gate_status,
    rejection_codes,
    evidence_quotes,
    gate_version,
    created_at AS gate_evaluated_at
  FROM gate_decisions
  ORDER BY canonical_job_id, created_at DESC
),
latest_evaluations AS (
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
latest_queue AS (
  SELECT DISTINCT ON (canonical_job_id)
    canonical_job_id,
    status AS queue_status,
    priority_score,
    attempt_count,
    last_error,
    available_at
  FROM evaluation_queue
  ORDER BY canonical_job_id, available_at DESC
)
SELECT
  c.id                                                        AS canonical_job_id,
  tv.version_id                                               AS job_version_id,
  COALESCE(c.normalized_title, 'Unknown Title')               AS title,
  COALESCE(c.company_name, 'Unknown Company')                 AS company,
  c.canonical_url,
  COALESCE(lo.source_name, 'UNKNOWN')                         AS source,
  COALESCE(c.location, c.location_summary, 'Unknown')         AS location,
  COALESCE(c.workplace_type, 'UNKNOWN')                       AS workplace_type,
  COALESCE(c.employment_type, 'UNKNOWN')                      AS employment_type,
  tv.description_text                                         AS description,
  COALESCE(lg.gate_status, 'NEEDS_VERIFICATION')              AS gate_status,
  lg.rejection_codes,
  lg.evidence_quotes                                          AS gate_evidence_quotes,
  c.primary_lane,
  c.secondary_lanes,
  c.lane_confidence,
  COALESCE(lq.priority_score, 0.0)                            AS priority_score,
  c.processing_status,
  (le.full_evaluation_payload->>'nd_friendly_score')::numeric   AS nd_friendly_score,
  (le.full_evaluation_payload->>'politics_stress_score')::numeric AS politics_stress_score,
  (le.full_evaluation_payload->>'sensory_overload_index')::numeric AS sensory_overload_index,
  le.full_evaluation_payload->>'next_action'                  AS next_action,
  le.full_evaluation_payload->>'strategic_value'              AS strategic_value,
  le.full_evaluation_payload->>'recommended_cv_version'       AS recommended_cv_version,
  le.full_evaluation_payload->>'evaluation_summary'           AS evaluation_summary,
  le.eval_provider,
  le.eval_is_fallback,
  (le.eval_id IS NULL AND c.processing_status IN ('AI_EVALUATED', 'EVALUATED')) AS version_mismatch,
  tv.observed_at,
  le.evaluated_at,
  le.lane_matches,
  le.workability_facts,
  lq.queue_status
FROM canonical_jobs c
JOIN target_versions tv ON tv.canonical_job_id = c.id
LEFT JOIN latest_observations lo ON lo.job_version_id = tv.version_id
LEFT JOIN latest_gates lg ON lg.canonical_job_id = c.id
LEFT JOIN latest_evaluations le ON le.canonical_job_id = c.id AND le.job_version_id = tv.version_id
LEFT JOIN latest_queue lq ON lq.canonical_job_id = c.id
WHERE c.processing_status NOT IN ('HARD_REJECTED', 'MANUALLY_REMOVED');

CREATE OR REPLACE VIEW shortlist_view AS
SELECT * FROM v_canonical_shortlist;
