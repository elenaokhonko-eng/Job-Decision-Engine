-- Migration 003: Canonical Schema Hardening, Indexes, Constraints, and Read Model View

-- 1. Ensure all columns exist on canonical_jobs (additive)
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS company_name TEXT;
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS normalized_title TEXT;
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS canonical_url TEXT;
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS location_summary TEXT DEFAULT 'Unknown';
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS workplace_type VARCHAR(50) DEFAULT 'UNKNOWN';
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS employment_type VARCHAR(50) DEFAULT 'UNKNOWN';
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS processing_status VARCHAR(50) DEFAULT 'RAW_STAGED';
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS gate_decision VARCHAR(50);
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS primary_lane VARCHAR(50);
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS secondary_lanes JSONB;
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS lane_confidence VARCHAR(50);
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS lane_evidence TEXT;
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS semantic_score FLOAT DEFAULT 0.0;
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS version_count INT DEFAULT 1;
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS latest_job_version_id UUID;
ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 2. Ensure all columns exist on raw_job_observations (additive)
ALTER TABLE raw_job_observations ADD COLUMN IF NOT EXISTS processing_status VARCHAR(50) DEFAULT 'PENDING';
ALTER TABLE raw_job_observations ADD COLUMN IF NOT EXISTS raw_payload_hash VARCHAR(255);
ALTER TABLE raw_job_observations ADD COLUMN IF NOT EXISTS raw_payload JSONB;
ALTER TABLE raw_job_observations ADD COLUMN IF NOT EXISTS error_history JSONB DEFAULT '[]'::jsonb;
ALTER TABLE raw_job_observations ADD COLUMN IF NOT EXISTS source_lane VARCHAR(50);
ALTER TABLE raw_job_observations ADD COLUMN IF NOT EXISTS search_plan_version VARCHAR(50) DEFAULT '1.0';

-- 3. Ensure all columns exist on evaluation_queue
ALTER TABLE evaluation_queue ADD COLUMN IF NOT EXISTS job_version_id VARCHAR(50) DEFAULT 'v1';
ALTER TABLE evaluation_queue ADD COLUMN IF NOT EXISTS lease_id UUID;
ALTER TABLE evaluation_queue ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE evaluation_queue ADD COLUMN IF NOT EXISTS attempt_count INT DEFAULT 0;
ALTER TABLE evaluation_queue ADD COLUMN IF NOT EXISTS max_attempts INT DEFAULT 3;
ALTER TABLE evaluation_queue ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE evaluation_queue ADD COLUMN IF NOT EXISTS enqueued_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE evaluation_queue ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 4. Ensure all columns exist on ai_evaluations
ALTER TABLE ai_evaluations ADD COLUMN IF NOT EXISTS provider VARCHAR(50) DEFAULT 'gemini';
ALTER TABLE ai_evaluations ADD COLUMN IF NOT EXISTS model VARCHAR(100) DEFAULT 'gemini-1.5-flash';
ALTER TABLE ai_evaluations ADD COLUMN IF NOT EXISTS attempt INT DEFAULT 1;
ALTER TABLE ai_evaluations ADD COLUMN IF NOT EXISTS is_fallback BOOLEAN DEFAULT FALSE;
ALTER TABLE ai_evaluations ADD COLUMN IF NOT EXISTS degraded_state BOOLEAN DEFAULT FALSE;
ALTER TABLE ai_evaluations ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10, 6) DEFAULT 0.000000;
ALTER TABLE ai_evaluations ADD COLUMN IF NOT EXISTS full_evaluation_payload JSONB;

-- 5. Create performant indexes
CREATE INDEX IF NOT EXISTS idx_canonical_jobs_status ON canonical_jobs(processing_status);
CREATE INDEX IF NOT EXISTS idx_canonical_jobs_company_title ON canonical_jobs(company_name, normalized_title);
CREATE INDEX IF NOT EXISTS idx_eval_queue_status_lane ON evaluation_queue(status, lane, priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_eval_queue_lease ON evaluation_queue(lease_id, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_job_versions_canonical ON job_versions(canonical_job_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_evaluations_canonical ON ai_evaluations(canonical_job_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_raw_obs_status ON raw_job_observations(processing_status);
CREATE INDEX IF NOT EXISTS idx_raw_obs_hash ON raw_job_observations(raw_payload_hash);

-- 5. Canonical Read Model View for Streamlit & Dashboard Consumers
CREATE OR REPLACE VIEW v_canonical_shortlist AS
SELECT 
    c.id AS canonical_job_id,
    COALESCE(jv.id::text, 'v1') AS job_version_id,
    c.normalized_title AS title,
    c.company_name AS company,
    c.canonical_url,
    COALESCE(c.location_summary, 'Unknown') AS location,
    COALESCE(c.workplace_type, 'UNKNOWN') AS workplace_type,
    COALESCE(c.gate_decision, 'PASS') AS gate_status,
    COALESCE(
        ae.full_evaluation_payload->>'primary_lane',
        c.primary_lane
    ) AS primary_lane,
    COALESCE(
        ae.full_evaluation_payload->'secondary_lanes',
        '[]'::jsonb
    ) AS secondary_lanes,
    COALESCE(
        ae.full_evaluation_payload->>'lane_confidence',
        'None'
    ) AS lane_confidence,
    COALESCE(c.semantic_score, 0.0) AS priority_score,
    c.processing_status,
    (ae.full_evaluation_payload->>'nd_friendly_score')::int AS nd_friendly_score,
    (ae.full_evaluation_payload->>'politics_stress_score')::int AS politics_stress_score,
    ae.full_evaluation_payload->>'next_action' AS next_action,
    ae.full_evaluation_payload->>'strategic_value' AS strategic_value,
    ae.full_evaluation_payload->>'recommended_cv_version' AS recommended_cv_version,
    c.created_at AS observed_at,
    ae.evaluated_at
FROM canonical_jobs c
LEFT JOIN LATERAL (
    SELECT id, observed_at 
    FROM job_versions 
    WHERE canonical_job_id = c.id 
    ORDER BY observed_at DESC 
    LIMIT 1
) jv ON TRUE
LEFT JOIN LATERAL (
    SELECT evaluated_at, full_evaluation_payload 
    FROM ai_evaluations 
    WHERE canonical_job_id = c.id 
    ORDER BY evaluated_at DESC 
    LIMIT 1
) ae ON TRUE;
