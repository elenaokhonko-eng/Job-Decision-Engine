-- Migration 039: explicit dependency-blocked pipeline tasks
--
-- Dependency blocking is not an operational failure and is not task completion.
-- The task remains auditable and is reactivated when its prerequisite is enqueued
-- or completed. This migration is additive and preserves all existing rows.

ALTER TABLE pipeline_tasks
  ADD COLUMN IF NOT EXISTS context_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS blocked_on TEXT,
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT,
  ADD COLUMN IF NOT EXISTS repair_action TEXT;

ALTER TABLE pipeline_tasks
  DROP CONSTRAINT IF EXISTS pipeline_tasks_status_check;

ALTER TABLE pipeline_tasks
  ADD CONSTRAINT pipeline_tasks_status_check
  CHECK (status IN (
    'PENDING',
    'RUNNING',
    'COMPLETED',
    'RETRY_WAIT',
    'BLOCKED_DEPENDENCY',
    'DEAD_LETTER'
  ));

ALTER TABLE pipeline_task_attempts
  DROP CONSTRAINT IF EXISTS pipeline_task_attempts_status_check;

ALTER TABLE pipeline_task_attempts
  ADD CONSTRAINT pipeline_task_attempts_status_check
  CHECK (status IN ('STARTED', 'FAILED', 'BLOCKED', 'COMPLETED'));

CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_blocked_dependency
  ON pipeline_tasks(workspace_id, status, blocked_on, updated_at);

COMMENT ON COLUMN pipeline_tasks.context_fingerprint IS
  'Deterministic input-context identity for currentness; null is legacy/unversioned work.';

COMMENT ON COLUMN pipeline_tasks.blocked_on IS
  'Logical prerequisite that must produce a valid artifact before this task can run.';

-- A completed extraction is current only when its completed run points at the
-- job version's active requirement set. A completed legacy run without an
-- active set is not sufficient, including when it produced zero requirements.
CREATE OR REPLACE FUNCTION jdec_has_current_requirement_extraction(
  p_workspace_id UUID,
  p_job_version_id UUID,
  p_run_type TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM job_versions jv
    JOIN requirement_sets rs
      ON rs.workspace_id = jv.workspace_id
     AND rs.id = jv.active_requirement_set_id
     AND rs.job_version_id = jv.id
    JOIN requirement_extraction_runs rer
      ON rer.workspace_id = jv.workspace_id
     AND rer.job_version_id = jv.id
     AND rer.requirement_set_id = rs.id
     AND rer.run_type = p_run_type
     AND rer.status = 'COMPLETED'
    WHERE jv.workspace_id = p_workspace_id
      AND jv.id = p_job_version_id
  );
$$;
