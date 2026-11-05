-- Rollback: DROP TABLE IF EXISTS pipeline_worker_progress_snapshots;
CREATE TABLE pipeline_worker_progress_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_key TEXT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active_pending_count INTEGER NOT NULL CHECK (active_pending_count >= 0),
  oldest_pending_task_id UUID,
  oldest_pending_task_type TEXT,
  oldest_pending_created_at TIMESTAMPTZ,
  oldest_pending_age_seconds INTEGER NOT NULL CHECK (oldest_pending_age_seconds >= 0),
  CONSTRAINT pipeline_worker_progress_snapshots_workspace_run_key
    UNIQUE (workspace_id, run_key)
);

CREATE INDEX idx_pipeline_worker_progress_snapshots_recent
  ON pipeline_worker_progress_snapshots (workspace_id, completed_at DESC, id DESC);
