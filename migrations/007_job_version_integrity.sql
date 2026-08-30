-- Migration 007: Job-version integrity & foreign key hardening
-- Ensures canonical_jobs and evaluation_queue maintain explicit, transactionally updated job_version references.

-- 1. Ensure columns exist on canonical_jobs
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS latest_job_version_id UUID;
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS version_count INT DEFAULT 1;
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS location VARCHAR(255);
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS workplace_type VARCHAR(100);
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS employment_type VARCHAR(100);

-- 2. Ensure job_version_id exists on evaluation_queue
ALTER TABLE evaluation_queue ADD COLUMN IF NOT EXISTS job_version_id UUID;

-- 3. Backfill latest_job_version_id and version_count on canonical_jobs if missing
WITH ranked_versions AS (
  SELECT 
    canonical_job_id,
    id AS latest_id,
    COUNT(*) OVER (PARTITION BY canonical_job_id) AS total_versions,
    ROW_NUMBER() OVER (PARTITION BY canonical_job_id ORDER BY observed_at DESC) AS rn
  FROM job_versions
)
UPDATE canonical_jobs c
SET 
  latest_job_version_id = rv.latest_id,
  version_count = rv.total_versions
FROM ranked_versions rv
WHERE c.id = rv.canonical_job_id AND rv.rn = 1 AND (c.latest_job_version_id IS NULL OR c.version_count IS NULL);

-- 4. Backfill evaluation_queue.job_version_id if null and valid reference exists
UPDATE evaluation_queue eq
SET job_version_id = c.latest_job_version_id
FROM canonical_jobs c
WHERE eq.canonical_job_id = c.id AND eq.job_version_id IS NULL AND c.latest_job_version_id IS NOT NULL;

-- 4b. Clean up orphaned evaluation_queue rows that still have NULL job_version_id
-- These are records whose canonical_job has no job_versions (data integrity issue)
DELETE FROM evaluation_queue
WHERE job_version_id IS NULL AND canonical_job_id IN (
  SELECT c.id FROM canonical_jobs c
  WHERE c.latest_job_version_id IS NULL
);

-- 5. Add foreign key constraints safely
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'fk_canonical_jobs_latest_version'
  ) THEN
    ALTER TABLE canonical_jobs
    ADD CONSTRAINT fk_canonical_jobs_latest_version
    FOREIGN KEY (latest_job_version_id) REFERENCES job_versions(id)
    ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'fk_evaluation_queue_job_version'
  ) THEN
    ALTER TABLE evaluation_queue
    ADD CONSTRAINT fk_evaluation_queue_job_version
    FOREIGN KEY (job_version_id) REFERENCES job_versions(id)
    ON DELETE CASCADE;
  END IF;
END $$;

-- 6. Updated v_canonical_shortlist read model
DROP VIEW IF EXISTS v_canonical_shortlist;

CREATE OR REPLACE VIEW v_canonical_shortlist AS
WITH latest_version AS (
  SELECT DISTINCT ON (canonical_job_id)
    id                     AS version_id,
    canonical_job_id,
    description_text,
    observed_at
  FROM job_versions
  ORDER BY canonical_job_id, observed_at DESC
),
latest_gate AS (
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
  SELECT DISTINCT ON (canonical_job_id)
    canonical_job_id,
    job_version_id          AS eval_version_id,
    lane_matches,
    workability_facts,
    full_evaluation_payload,
    provider                AS eval_provider,
    is_fallback,
    evaluated_at,
    (full_evaluation_payload->>'nd_score')::numeric                  AS nd_friendly_score,
    (full_evaluation_payload->>'nd_friendly_score')::numeric         AS nd_score_alt,
    (full_evaluation_payload->>'politics_stress_score')::numeric    AS politics_stress_score,
    (full_evaluation_payload->>'sensory_overload_index')::numeric    AS sensory_overload_index,
    full_evaluation_payload->>'next_action'                          AS next_action,
    full_evaluation_payload->>'strategic_value'                      AS strategic_value,
    full_evaluation_payload->>'recommended_cv_version'               AS recommended_cv_version,
    full_evaluation_payload->>'evaluation_summary'                   AS evaluation_summary
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
  COALESCE(c.location, c.location_summary, 'Singapore') AS location,
  COALESCE(c.workplace_type, 'UNKNOWN')             AS workplace_type,
  COALESCE(c.employment_type, 'PERMANENT')          AS employment_type,
  lv.description_text                               AS description,

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
  (le.eval_version_id IS NOT NULL AND le.eval_version_id::text <> lv.version_id::text) AS version_mismatch,
  COALESCE(le.nd_friendly_score, le.nd_score_alt, 0) AS nd_friendly_score,
  COALESCE(le.politics_stress_score, 50)            AS politics_stress_score,
  COALESCE(le.sensory_overload_index, 50)           AS sensory_overload_index,
  le.next_action,
  le.strategic_value,
  le.recommended_cv_version,
  le.evaluation_summary,
  le.eval_provider,
  le.is_fallback                                    AS eval_is_fallback,
  le.evaluated_at,
  le.lane_matches,
  le.workability_facts,

  -- Scoring & queue
  eq.priority_score,
  eq.status                                         AS queue_status,

  -- Timestamps & counts
  COALESCE(c.version_count, 1)                      AS version_count,
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
