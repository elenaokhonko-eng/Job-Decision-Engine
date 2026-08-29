-- Migration 006: Schema hardening v2
-- Additive migration for queue uniqueness, version references, observation deduplication, and updated read model.

-- 1. Ensure columns exist on raw_email_alerts
ALTER TABLE raw_email_alerts ADD COLUMN IF NOT EXISTS gmail_message_id TEXT;
ALTER TABLE raw_email_alerts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE raw_email_alerts ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE raw_email_alerts ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
ALTER TABLE raw_email_alerts ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_email_alerts_gmail_uid ON raw_email_alerts (gmail_message_id);

-- 2. Deduplication index on raw_job_observations payload hash
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_job_observations_payload_hash ON raw_job_observations (raw_payload_hash);

-- 3. Version tracking columns on canonical_jobs
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS latest_job_version_id UUID;
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS version_count INT DEFAULT 1;

-- 4. Active queue uniqueness: only one active entry per canonical job
CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluation_queue_active_job 
ON evaluation_queue (canonical_job_id) 
WHERE status IN ('PENDING', 'EVALUATING', 'RETRY_WAIT');

-- 5. Recreate v_canonical_shortlist read model
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
  COALESCE(c.location_summary, 'Unknown')           AS location,
  COALESCE(c.workplace_type, 'UNKNOWN')             AS workplace_type,

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
