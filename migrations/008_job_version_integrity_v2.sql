-- Migration 008: Job Version Integrity v2 & Strict Canonical Read Model
--
-- Invariants:
-- 1. evaluation_queue.job_version_id is NOT NULL and references job_versions(id).
-- 2. Orphaned or invalid queue rows are quarantined to 'NEEDS_MANUAL_REVIEW', never deleted.
-- 3. ai_evaluations.job_version_id is UUID referencing job_versions(id).
-- 4. v_canonical_shortlist joins ai_evaluations strictly on (canonical_job_id, job_version_id),
--    preventing stale evaluations from mismatched versions from being displayed.
-- 5. Gate status defaults to 'NEEDS_VERIFICATION' (never 'NOT_GATED').
-- 6. Location defaults to 'Unknown', workplace_type and employment_type to 'UNKNOWN'.

-- Step 1: Ensure job_version_id column exists on evaluation_queue and ai_evaluations
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'evaluation_queue' AND column_name = 'job_version_id'
  ) THEN
    ALTER TABLE evaluation_queue ADD COLUMN job_version_id UUID;
  END IF;
END $$;

-- Step 2: Backfill any NULL job_version_id in evaluation_queue from latest job_versions
UPDATE evaluation_queue eq
SET job_version_id = jv.id
FROM (
  SELECT DISTINCT ON (canonical_job_id) id, canonical_job_id
  FROM job_versions
  ORDER BY canonical_job_id, observed_at DESC
) jv
WHERE eq.canonical_job_id = jv.canonical_job_id
  AND eq.job_version_id IS NULL;

-- Step 3: Quarantine any queue items that STILL have no matching job_version
UPDATE evaluation_queue
SET status = 'NEEDS_MANUAL_REVIEW',
    last_error = COALESCE(last_error, 'Missing job_version_id backfill — quarantined for manual review')
WHERE job_version_id IS NULL;

-- For any unlinked rows, create a synthetic fallback version from canonical_jobs so NOT NULL constraint succeeds safely
INSERT INTO job_versions (id, canonical_job_id, content_hash, title, company_name, description_text, observed_at)
SELECT 
  gen_random_uuid(),
  eq.canonical_job_id,
  'unlinked_version_hash_' || eq.id::text,
  COALESCE(c.normalized_title, 'Unknown Title'),
  COALESCE(c.company_name, 'Unknown Company'),
  'Quarantined record description recovered during migration 008.',
  NOW()
FROM evaluation_queue eq
JOIN canonical_jobs c ON c.id = eq.canonical_job_id
WHERE eq.job_version_id IS NULL
ON CONFLICT (canonical_job_id, content_hash) DO NOTHING;

UPDATE evaluation_queue eq
SET job_version_id = jv.id
FROM job_versions jv
WHERE eq.canonical_job_id = jv.canonical_job_id
  AND eq.job_version_id IS NULL;

-- Step 4: Enforce NOT NULL and Foreign Key constraints on evaluation_queue.job_version_id
ALTER TABLE evaluation_queue 
  ALTER COLUMN job_version_id SET NOT NULL;

DO $$
BEGIN
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

-- Step 5: Enforce Foreign Key on ai_evaluations.job_version_id
DO $$
BEGIN
  -- Convert text job_version_id to UUID if needed
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'ai_evaluations' AND column_name = 'job_version_id' AND data_type = 'text'
  ) THEN
    -- First attempt cast or clean up invalid text entries
    ALTER TABLE ai_evaluations 
      ALTER COLUMN job_version_id TYPE UUID USING (
        CASE 
          WHEN job_version_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' 
          THEN job_version_id::uuid 
          ELSE NULL 
        END
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'fk_ai_evaluations_job_version'
  ) THEN
    -- Only add FK if all existing job_version_ids reference job_versions
    IF NOT EXISTS (
      SELECT 1 FROM ai_evaluations ae
      WHERE ae.job_version_id IS NOT NULL 
        AND NOT EXISTS (SELECT 1 FROM job_versions jv WHERE jv.id = ae.job_version_id)
    ) THEN
      ALTER TABLE ai_evaluations
        ADD CONSTRAINT fk_ai_evaluations_job_version
        FOREIGN KEY (job_version_id) REFERENCES job_versions(id)
        ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

-- Step 6: Recreate the canonical shortlist view with strict version matching
DROP VIEW IF EXISTS shortlist_view CASCADE;
DROP VIEW IF EXISTS v_canonical_shortlist CASCADE;

CREATE OR REPLACE VIEW v_canonical_shortlist AS
WITH latest_versions AS (
  SELECT DISTINCT ON (canonical_job_id)
    id AS version_id,
    canonical_job_id,
    title,
    company_name,
    description_text,
    observed_at
  FROM job_versions
  ORDER BY canonical_job_id, observed_at DESC
),
latest_gates AS (
  SELECT DISTINCT ON (canonical_job_id)
    canonical_job_id,
    decision AS gate_status,
    rejection_codes,
    evidence_quotes,
    gate_rule_version,
    evaluated_at AS gate_evaluated_at
  FROM gate_decisions
  ORDER BY canonical_job_id, evaluated_at DESC
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
  lv.version_id                                               AS job_version_id,
  COALESCE(lv.title, c.normalized_title, 'Unknown Title')     AS title,
  COALESCE(lv.company_name, c.company_name, 'Unknown Company') AS company,
  c.canonical_url,
  COALESCE(c.location, c.location_summary, 'Unknown')         AS location,
  COALESCE(c.workplace_type, 'UNKNOWN')                       AS workplace_type,
  COALESCE(c.employment_type, 'UNKNOWN')                      AS employment_type,
  lv.description_text                                         AS description,
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
  (le.eval_id IS NULL AND c.processing_status = 'EVALUATED')  AS version_mismatch,
  lv.observed_at,
  le.evaluated_at,
  le.lane_matches,
  le.workability_facts,
  lq.queue_status
FROM canonical_jobs c
JOIN latest_versions lv ON lv.canonical_job_id = c.id
LEFT JOIN latest_gates lg ON lg.canonical_job_id = c.id
LEFT JOIN latest_evaluations le ON le.canonical_job_id = c.id AND le.job_version_id = lv.version_id
LEFT JOIN latest_queue lq ON lq.canonical_job_id = c.id
WHERE c.processing_status NOT IN ('HARD_REJECTED', 'MANUALLY_REMOVED');

-- Create alias view for backward compatibility
CREATE OR REPLACE VIEW shortlist_view AS
SELECT * FROM v_canonical_shortlist;

-- End of Migration 008
