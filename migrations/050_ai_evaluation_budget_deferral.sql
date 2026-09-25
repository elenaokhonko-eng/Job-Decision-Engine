-- Migration 050: Durable AI evaluation budget reservations and deferrals
--
-- Capacity overflow is a recoverable lifecycle state. It must remain
-- distinguishable from deterministic rejection and must be eligible again in a
-- later budget run. This migration is additive and preserves existing queue
-- and canonical-job history.

ALTER TABLE evaluation_queue
  ADD COLUMN IF NOT EXISTS budget_run_id UUID;

CREATE TABLE IF NOT EXISTS ai_evaluation_budget_runs (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_evaluation_budget_runs_workspace
  ON ai_evaluation_budget_runs (workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS ai_evaluation_budget_usage (
  budget_run_id UUID NOT NULL REFERENCES ai_evaluation_budget_runs(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lane TEXT NOT NULL,
  budget_limit INTEGER NOT NULL CHECK (budget_limit >= 0),
  selected_count INTEGER NOT NULL DEFAULT 0 CHECK (selected_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (budget_run_id, lane)
);

CREATE INDEX IF NOT EXISTS idx_ai_evaluation_budget_usage_workspace
  ON ai_evaluation_budget_usage (workspace_id, budget_run_id);

CREATE TABLE IF NOT EXISTS evaluation_budget_deferrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
  job_version_id UUID NOT NULL REFERENCES job_versions(id) ON DELETE CASCADE,
  budget_run_id UUID NOT NULL REFERENCES ai_evaluation_budget_runs(id) ON DELETE CASCADE,
  lane TEXT NOT NULL,
  budget_limit INTEGER NOT NULL CHECK (budget_limit >= 0),
  lane_rank INTEGER NOT NULL CHECK (lane_rank > 0),
  reason_code TEXT NOT NULL CHECK (
    reason_code IN ('AI_BUDGET_EXHAUSTED', 'AI_BUDGET_UNCONFIGURED_LANE')
  ),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (budget_run_id, canonical_job_id, job_version_id)
);

CREATE INDEX IF NOT EXISTS idx_evaluation_budget_deferrals_job
  ON evaluation_budget_deferrals (workspace_id, canonical_job_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_evaluation_queue_budget_run
  ON evaluation_queue (workspace_id, budget_run_id)
  WHERE budget_run_id IS NOT NULL;

COMMENT ON TABLE ai_evaluation_budget_runs IS
  'Audit identity for one bounded AI-enqueue run; the same id is reused across task-level enqueue retries.';
COMMENT ON TABLE ai_evaluation_budget_usage IS
  'Per-lane capacity reservations for a budget run, preventing task-level retries from exceeding the configured cap.';
COMMENT ON TABLE evaluation_budget_deferrals IS
  'Durable audit of eligible jobs deferred only because the AI capacity budget was exhausted.';
