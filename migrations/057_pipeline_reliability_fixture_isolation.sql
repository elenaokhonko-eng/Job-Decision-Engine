-- Migration 057: isolate release fixtures from operational processing and read models.
--
-- The marker is additive and preserves historical canary evidence. Operational
-- task, shortlist, and metrics consumers exclude fixtures by default; rehearsal
-- paths can explicitly query the underlying canonical records when needed.

ALTER TABLE canonical_jobs
  ADD COLUMN IF NOT EXISTS is_test_fixture BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_canonical_jobs_operational
  ON canonical_jobs (workspace_id, is_test_fixture, updated_at DESC);

-- Funnel V3 release canaries use deterministic canonical/job-version UUIDs.
-- Mark both historic and current canaries without deleting their audit trail.
UPDATE canonical_jobs canonical
SET is_test_fixture = TRUE,
    updated_at = NOW()
WHERE canonical.id::text LIKE 'c0000000-0000-4000-8000-%'
   OR EXISTS (
     SELECT 1
     FROM job_versions version
     WHERE version.workspace_id = canonical.workspace_id
       AND version.canonical_job_id = canonical.id
       AND version.id::text LIKE 'd0000000-0000-4000-8000-%'
   );

CREATE TABLE IF NOT EXISTS pipeline_run_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_name TEXT NOT NULL,
  run_key TEXT NOT NULL,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, workflow_name, run_key)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_run_reports_workspace_created
  ON pipeline_run_reports (workspace_id, created_at DESC);

CREATE OR REPLACE VIEW v_current_user_actions AS
WITH latest_gates AS (
  SELECT DISTINCT ON (decision.workspace_id, decision.canonical_job_id, decision.job_version_id)
    decision.id,
    decision.workspace_id,
    decision.canonical_job_id,
    decision.job_version_id,
    decision.decision,
    decision.created_at
  FROM gate_decisions decision
  ORDER BY decision.workspace_id, decision.canonical_job_id, decision.job_version_id, decision.created_at DESC, decision.id DESC
),
active_profiles AS (
  SELECT DISTINCT ON (workspace_id)
    workspace_id,
    id
  FROM profile_versions
  WHERE status = 'ACTIVE'
  ORDER BY workspace_id, created_at DESC, id DESC
)
SELECT DISTINCT ON (link.workspace_id, link.canonical_job_id, link.job_version_id)
  link.workspace_id,
  link.canonical_job_id,
  link.job_version_id,
  link.verification_question_id,
  'VERIFICATION_QUESTION'::text AS action_type,
  question.category AS action_category,
  'OPEN'::text AS action_status
FROM verification_question_job_links link
JOIN verification_questions question
  ON question.id = link.verification_question_id
 AND question.workspace_id = link.workspace_id
JOIN canonical_jobs job
  ON job.id = link.canonical_job_id
 AND job.workspace_id = link.workspace_id
JOIN latest_gates gate
  ON gate.id = link.gate_decision_id
 AND gate.workspace_id = link.workspace_id
 AND gate.canonical_job_id = link.canonical_job_id
 AND gate.job_version_id = link.job_version_id
LEFT JOIN active_profiles profile
  ON profile.workspace_id = link.workspace_id
WHERE link.status = 'OPEN'
  AND question.status = 'PENDING'
  AND job.is_test_fixture = FALSE
  AND COALESCE(job.processing_state, job.processing_status) = 'NEEDS_VERIFICATION'
  AND job.latest_job_version_id = link.job_version_id
  AND gate.decision = 'NEEDS_VERIFICATION'
  AND (link.profile_version_id IS NULL OR link.profile_version_id = profile.id)
  AND (
    link.preference_mode_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM workspace_user_preference_modes mode
      WHERE mode.id = link.preference_mode_id
        AND mode.workspace_id = link.workspace_id
        AND mode.is_active = TRUE
    )
  )
ORDER BY link.workspace_id, link.canonical_job_id, link.job_version_id, question.updated_at DESC, link.created_at DESC;

CREATE OR REPLACE VIEW v_canonical_shortlist_scoped AS
SELECT
  canonical.workspace_id,
  shortlist.*,
  CASE
    WHEN blocked.blocked_task_count > 0 THEN 'BLOCKED_DEPENDENCY'
    WHEN shortlist.gate_status = 'PASS' AND (
      active_profile.id IS NULL
      OR target_version.active_requirement_set_id IS NULL
      OR match_run.id IS NULL
      OR match_run.status <> 'COMPLETED'
      OR match_run.canonical_job_id IS DISTINCT FROM canonical.id
      OR match_run.job_version_id IS DISTINCT FROM target_version.id
      OR match_run.profile_version_id IS DISTINCT FROM active_profile.id
      OR match_run.requirement_set_id IS DISTINCT FROM target_version.active_requirement_set_id
      OR match_run.job_content_hash IS DISTINCT FROM target_version.content_hash
      OR match_run.context_fingerprint IS NULL
    ) THEN 'MATCH_STALE'
    WHEN shortlist.gate_status = 'PASS' AND (
      deterministic_decision.id IS NULL
      OR deterministic_decision.canonical_job_id IS DISTINCT FROM canonical.id
      OR deterministic_decision.job_version_id IS DISTINCT FROM target_version.id
      OR deterministic_decision.match_run_id IS DISTINCT FROM match_run.id
      OR deterministic_decision.context_fingerprint IS NULL
    ) THEN 'DECISION_STALE'
    WHEN shortlist.gate_status = 'PASS' AND latest_evaluation.id IS NULL THEN 'EVALUATION_MISSING'
    WHEN shortlist.gate_status = 'PASS' AND (
      latest_evaluation.profile_version_id IS DISTINCT FROM active_profile.id
      OR latest_evaluation.canonical_job_id IS DISTINCT FROM canonical.id
      OR latest_evaluation.job_version_id IS DISTINCT FROM target_version.id
      OR latest_evaluation.match_run_id IS DISTINCT FROM match_run.id
      OR latest_evaluation.deterministic_decision_id IS DISTINCT FROM deterministic_decision.id
      OR latest_evaluation.job_content_hash IS DISTINCT FROM target_version.content_hash
      OR latest_evaluation.context_fingerprint IS NULL
    ) THEN 'EVALUATION_STALE'
    WHEN shortlist.version_mismatch THEN 'EVALUATION_STALE'
    ELSE 'CURRENT_OR_NOT_APPLICABLE'
  END AS current_artifact_status,
  CASE
    WHEN blocked.blocked_task_count > 0 THEN blocked.blocked_reason
    WHEN shortlist.gate_status = 'PASS' AND active_profile.id IS NULL THEN 'NO_ACTIVE_PROFILE'
    WHEN shortlist.gate_status = 'PASS' AND target_version.active_requirement_set_id IS NULL THEN 'NO_ACTIVE_REQUIREMENT_SET'
    WHEN shortlist.gate_status = 'PASS' AND match_run.id IS NULL THEN 'NO_CURRENT_MATCH_RUN'
    WHEN shortlist.gate_status = 'PASS' AND match_run.status <> 'COMPLETED' THEN 'MATCH_RUN_NOT_COMPLETED'
    WHEN shortlist.gate_status = 'PASS' AND match_run.canonical_job_id IS DISTINCT FROM canonical.id THEN 'MATCH_CANONICAL_JOB_STALE'
    WHEN shortlist.gate_status = 'PASS' AND match_run.job_version_id IS DISTINCT FROM target_version.id THEN 'MATCH_JOB_VERSION_STALE'
    WHEN shortlist.gate_status = 'PASS' AND match_run.profile_version_id IS DISTINCT FROM active_profile.id THEN 'MATCH_PROFILE_VERSION_STALE'
    WHEN shortlist.gate_status = 'PASS' AND match_run.requirement_set_id IS DISTINCT FROM target_version.active_requirement_set_id THEN 'MATCH_REQUIREMENT_SET_STALE'
    WHEN shortlist.gate_status = 'PASS' AND match_run.job_content_hash IS DISTINCT FROM target_version.content_hash THEN 'MATCH_JOB_CONTENT_STALE'
    WHEN shortlist.gate_status = 'PASS' AND match_run.context_fingerprint IS NULL THEN 'MATCH_CONTEXT_UNPROVABLE'
    WHEN shortlist.gate_status = 'PASS' AND deterministic_decision.id IS NULL THEN 'NO_CURRENT_DETERMINISTIC_DECISION'
    WHEN shortlist.gate_status = 'PASS' AND deterministic_decision.canonical_job_id IS DISTINCT FROM canonical.id THEN 'DECISION_CANONICAL_JOB_STALE'
    WHEN shortlist.gate_status = 'PASS' AND deterministic_decision.job_version_id IS DISTINCT FROM target_version.id THEN 'DECISION_JOB_VERSION_STALE'
    WHEN shortlist.gate_status = 'PASS' AND deterministic_decision.match_run_id IS DISTINCT FROM match_run.id THEN 'DECISION_MATCH_RUN_STALE'
    WHEN shortlist.gate_status = 'PASS' AND deterministic_decision.context_fingerprint IS NULL THEN 'DECISION_CONTEXT_UNPROVABLE'
    WHEN shortlist.gate_status = 'PASS' AND latest_evaluation.id IS NULL THEN 'NO_CURRENT_AI_EVALUATION'
    WHEN shortlist.gate_status = 'PASS' AND latest_evaluation.context_fingerprint IS NULL THEN 'EVALUATION_CONTEXT_UNPROVABLE'
    WHEN shortlist.version_mismatch THEN 'NO_CURRENT_EVALUATION_FOR_DISPLAYED_VERSION'
    ELSE NULL
  END AS current_artifact_reason,
  blocked.blocked_task_count
FROM canonical_jobs canonical
JOIN v_canonical_shortlist shortlist
  ON shortlist.canonical_job_id = canonical.id
LEFT JOIN LATERAL (
  SELECT version.id, version.active_requirement_set_id, version.content_hash
  FROM job_versions version
  WHERE version.workspace_id = canonical.workspace_id
    AND version.id = shortlist.job_version_id::uuid
  LIMIT 1
) target_version ON TRUE
LEFT JOIN LATERAL (
  SELECT profile.id
  FROM profile_versions profile
  WHERE profile.workspace_id = canonical.workspace_id
    AND profile.status = 'ACTIVE'
  ORDER BY profile.created_at DESC
  LIMIT 1
) active_profile ON TRUE
LEFT JOIN LATERAL (
  SELECT
    candidate.id,
    candidate.status,
    candidate.canonical_job_id,
    candidate.job_version_id,
    candidate.profile_version_id,
    candidate.requirement_set_id,
    candidate.job_content_hash,
    candidate.context_fingerprint
  FROM match_runs candidate
  WHERE candidate.workspace_id = canonical.workspace_id
    AND candidate.id = canonical.latest_match_run_id
  LIMIT 1
) match_run ON TRUE
LEFT JOIN LATERAL (
  SELECT
    candidate.id,
    candidate.canonical_job_id,
    candidate.job_version_id,
    candidate.match_run_id,
    candidate.context_fingerprint
  FROM deterministic_decisions candidate
  WHERE candidate.workspace_id = canonical.workspace_id
    AND candidate.id = canonical.latest_deterministic_decision_id
  LIMIT 1
) deterministic_decision ON TRUE
LEFT JOIN LATERAL (
  SELECT candidate.id, candidate.canonical_job_id, candidate.job_version_id,
         candidate.profile_version_id, candidate.match_run_id,
         candidate.deterministic_decision_id, candidate.job_content_hash,
         candidate.context_fingerprint
  FROM ai_evaluations candidate
  WHERE candidate.workspace_id = canonical.workspace_id
    AND candidate.canonical_job_id = canonical.id
    AND candidate.job_version_id = shortlist.job_version_id::uuid
  ORDER BY candidate.evaluated_at DESC, candidate.id DESC
  LIMIT 1
) latest_evaluation ON TRUE
LEFT JOIN LATERAL (
  SELECT
    COUNT(*)::int AS blocked_task_count,
    MAX(task.blocked_reason) AS blocked_reason
  FROM pipeline_tasks task
  WHERE task.workspace_id = canonical.workspace_id
    AND task.status = 'BLOCKED_DEPENDENCY'
    AND (
      task.payload->>'canonical_job_id' = canonical.id::text
      OR task.payload->>'job_version_id' = shortlist.job_version_id::text
    )
) blocked ON TRUE
WHERE canonical.is_test_fixture = FALSE;

CREATE OR REPLACE VIEW v_rejected_jobs_audit_scoped AS
SELECT canonical.workspace_id, rejected.*
FROM canonical_jobs canonical
JOIN v_rejected_jobs_audit rejected ON rejected.id = canonical.id
WHERE canonical.is_test_fixture = FALSE;

CREATE OR REPLACE VIEW v_pipeline_task_queue_health AS
WITH operational_tasks AS (
  SELECT task.*
  FROM pipeline_tasks task
  WHERE NOT EXISTS (
    SELECT 1
    FROM canonical_jobs canonical
    LEFT JOIN job_versions version
      ON version.workspace_id = canonical.workspace_id
     AND version.canonical_job_id = canonical.id
    WHERE canonical.workspace_id = task.workspace_id
      AND canonical.is_test_fixture = TRUE
      AND (
        task.payload->>'canonical_job_id' = canonical.id::text
        OR task.payload->>'job_version_id' = version.id::text
      )
  )
)
SELECT
  workspace_id,
  task_type,
  status,
  COUNT(*)::int AS task_count,
  MIN(created_at) AS oldest_created_at,
  EXTRACT(EPOCH FROM NOW() - MIN(created_at))::bigint AS oldest_age_seconds
FROM operational_tasks
GROUP BY workspace_id, task_type, status;

COMMENT ON COLUMN canonical_jobs.is_test_fixture IS
  'Release/rehearsal fixture marker. Fixtures retain history but are excluded from normal operational processing.';
COMMENT ON TABLE pipeline_run_reports IS
  'Persisted per-workflow operational stage summaries generated from authoritative source and task artifacts.';
COMMENT ON VIEW v_pipeline_task_queue_health IS
  'Operational pipeline queue counts and ages, excluding canonical jobs marked as test fixtures.';
