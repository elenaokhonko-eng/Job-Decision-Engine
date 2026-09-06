-- Migration 035: v2.2 read-model + cutover tracking
--
-- Goals (P11):
-- 1) Provide durable, workspace-scoped tracking for resumable backfills.
-- 2) Persist parity/cutover audit outcomes for release evidence.
-- 3) Provide workspace-scoped cutover flags for staged write/read/worker cutover.
--
-- Notes:
-- - Additive and reversible (no destructive drops).
-- - Does not mutate existing canonical data; runtime scripts perform optional backfills.

-- ============================================================================
-- 1) Workspace-scoped cutover flags (stage-by-stage control)
-- ============================================================================

CREATE TABLE IF NOT EXISTS workspace_cutover_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  flag_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  note TEXT,
  updated_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, flag_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_cutover_flags_workspace
  ON workspace_cutover_flags(workspace_id, updated_at DESC);

-- ============================================================================
-- 2) Resumable backfill runs + checkpoints (dry-run supported by runtime)
-- ============================================================================

CREATE TABLE IF NOT EXISTS backfill_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  run_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'ABORTED')),
  dry_run BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backfill_runs_workspace_started
  ON backfill_runs(workspace_id, started_at DESC);

-- At most one running backfill per workspace/run_key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_backfill_runs_one_running
  ON backfill_runs(workspace_id, run_key)
  WHERE status = 'RUNNING';

CREATE TABLE IF NOT EXISTS backfill_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  backfill_run_id UUID NOT NULL REFERENCES backfill_runs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (backfill_run_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_backfill_checkpoints_run
  ON backfill_checkpoints(workspace_id, backfill_run_id, updated_at DESC);

-- ============================================================================
-- 3) Parity/cutover audit persistence (release evidence)
-- ============================================================================

CREATE TABLE IF NOT EXISTS parity_audit_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  audit_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PASSED', 'FAILED')),
  findings JSONB NOT NULL,
  expected_diff_signature TEXT,
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_parity_audit_runs_workspace_created
  ON parity_audit_runs(workspace_id, created_at DESC);
