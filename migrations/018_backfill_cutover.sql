-- Migration 018: Backfill cutover to deterministic matching and document provenance states
--
-- Goals:
-- 1) Normalize legacy statuses into current canonical state machine labels.
-- 2) Backfill canonical latest_match_run_id and deterministic scores from completed match runs.
-- 3) Backfill DOCUMENT_READY pipeline state from completed document_runs.

BEGIN;

-- Step 1: Normalize legacy/transition statuses to canonical labels.
UPDATE canonical_jobs
SET processing_status = 'AI_EVALUATED',
    updated_at = NOW()
WHERE processing_status = 'EVALUATED';

UPDATE canonical_jobs
SET processing_status = 'LANE_ROUTED',
    updated_at = NOW()
WHERE processing_status = 'SEMANTIC_SHORTLISTED';

-- Legacy terminal status from older pipelines should not be used in current flow.
-- Preserve records while moving them to manual review rather than rejection.
UPDATE canonical_jobs
SET processing_status = 'NEEDS_MANUAL_REVIEW',
    updated_at = NOW()
WHERE processing_status = 'REJECTED_AFTER_EVALUATION';

-- Step 2: Backfill deterministic matching pointers and scores from latest completed run.
WITH latest_runs AS (
  SELECT DISTINCT ON (mr.canonical_job_id, mr.job_version_id)
    mr.id,
    mr.canonical_job_id,
    mr.job_version_id,
    mr.overall_match_score,
    mr.coverage_score,
    mr.completed_at,
    mr.started_at
  FROM match_runs mr
  WHERE mr.status = 'COMPLETED'
  ORDER BY mr.canonical_job_id, mr.job_version_id, mr.completed_at DESC NULLS LAST, mr.started_at DESC
)
UPDATE canonical_jobs c
SET latest_match_run_id = lr.id,
    deterministic_match_score = COALESCE(c.deterministic_match_score, lr.overall_match_score),
    deterministic_match_coverage = COALESCE(c.deterministic_match_coverage, lr.coverage_score),
    processing_status = CASE
      WHEN c.processing_status IN ('LANE_ROUTED', 'PREQUALIFIED') THEN 'MATCHED'
      ELSE c.processing_status
    END,
    updated_at = NOW()
FROM latest_runs lr
WHERE c.id = lr.canonical_job_id
  AND c.latest_job_version_id = lr.job_version_id
  AND (
    c.latest_match_run_id IS DISTINCT FROM lr.id
    OR c.deterministic_match_score IS NULL
    OR c.deterministic_match_coverage IS NULL
    OR c.processing_status IN ('LANE_ROUTED', 'PREQUALIFIED')
  );

-- Step 3: If deterministic output exists but queue hasn't run yet, preserve MATCHED as active state.
UPDATE canonical_jobs c
SET processing_status = 'MATCHED',
    updated_at = NOW()
WHERE c.processing_status = 'LANE_ROUTED'
  AND c.latest_match_run_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM evaluation_queue eq
    WHERE eq.canonical_job_id = c.id
      AND eq.job_version_id = c.latest_job_version_id
  );

-- Step 4: Backfill DOCUMENT_READY stage states for versions with completed documents.
WITH ready_versions AS (
  SELECT DISTINCT
    dr.canonical_job_id,
    dr.job_version_id
  FROM document_runs dr
  WHERE dr.status = 'COMPLETED'
)
INSERT INTO job_version_pipeline_state (
  canonical_job_id,
  job_version_id,
  current_stage,
  stage_status,
  attempt_count,
  last_error,
  next_retry_at,
  created_at,
  updated_at
)
SELECT
  rv.canonical_job_id,
  rv.job_version_id,
  'DOCUMENT_READY',
  'COMPLETED',
  0,
  NULL,
  NULL,
  NOW(),
  NOW()
FROM ready_versions rv
ON CONFLICT (job_version_id)
DO UPDATE SET
  current_stage = 'DOCUMENT_READY',
  stage_status = 'COMPLETED',
  last_error = NULL,
  next_retry_at = NULL,
  updated_at = NOW();

-- Step 5: Append cutover event once for DOCUMENT_READY rows missing such an event.
WITH ready_versions AS (
  SELECT DISTINCT
    dr.canonical_job_id,
    dr.job_version_id
  FROM document_runs dr
  WHERE dr.status = 'COMPLETED'
)
INSERT INTO pipeline_stage_events (
  canonical_job_id,
  job_version_id,
  stage,
  transition_from,
  transition_to,
  event_type,
  error_message,
  payload,
  created_at
)
SELECT
  rv.canonical_job_id,
  rv.job_version_id,
  'DOCUMENT_READY',
  NULL,
  'COMPLETED',
  'STAGE_COMPLETED',
  NULL,
  '{"source":"phase8_backfill_cutover"}'::jsonb,
  NOW()
FROM ready_versions rv
WHERE NOT EXISTS (
  SELECT 1
  FROM pipeline_stage_events e
  WHERE e.job_version_id = rv.job_version_id
    AND e.stage = 'DOCUMENT_READY'
    AND e.transition_to = 'COMPLETED'
);

COMMIT;
