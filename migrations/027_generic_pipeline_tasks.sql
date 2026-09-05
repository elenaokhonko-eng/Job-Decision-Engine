-- Migration 027: Generic durable pipeline tasks
--
-- Goals (IDE Closeout Pack P8):
-- 1) Generic idempotent tasks with claim/lease/heartbeat.
-- 2) Explicit retry/dead-letter semantics with attempt history.
--
-- Notes:
-- - Additive and reversible (no destructive drops).
-- - Designed for shadow enqueue + staged cutover; does not replace existing queues yet.

BEGIN;

CREATE TABLE IF NOT EXISTS pipeline_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL,
  task_key TEXT NOT NULL,
  payload JSONB NOT NULL,

  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'RETRY_WAIT', 'DEAD_LETTER')),

  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  claimed_by TEXT,

  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  last_error TEXT,
  dead_letter_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  UNIQUE (workspace_id, task_key)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_claim
  ON pipeline_tasks(workspace_id, task_type, status, available_at, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_lease_expiry
  ON pipeline_tasks(workspace_id, status, lease_expires_at);

CREATE TABLE IF NOT EXISTS pipeline_task_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES pipeline_tasks(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL CHECK (status IN ('STARTED', 'FAILED', 'COMPLETED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  error_message TEXT,
  metadata JSONB,
  UNIQUE (task_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_task_attempts_task
  ON pipeline_task_attempts(task_id, attempt_number DESC);

COMMENT ON TABLE pipeline_tasks IS
  'Generic durable tasks with idempotent task_key, claim/lease/heartbeat, retry and dead-letter.';

COMMENT ON TABLE pipeline_task_attempts IS
  'Attempt ledger for durable tasks; preserves failure history for audit and replay.';

COMMIT;

