-- Migration 025: Executable policy snapshots and deterministic decisions
--
-- Goals (IDE Closeout Pack P6):
-- 1) Persist resolved workspace policy snapshots (references + hashes).
-- 2) Persist immutable deterministic decisions with full trace JSON.
-- 3) Keep canonical_jobs recommendation_* as denormalized "current" fields for read models.
--
-- Notes:
-- - Additive and reversible (no destructive drops).
-- - Snapshots and decisions are immutable; corrections create new rows.

BEGIN;

-- ============================================================================
-- 1) Resolved workspace policy snapshots
-- ============================================================================

CREATE TABLE IF NOT EXISTS workspace_policy_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_hash TEXT NOT NULL,
  schema_version TEXT NOT NULL DEFAULT '2.2.0',

  decision_policy_config_revision_id UUID REFERENCES config_revisions(id) ON DELETE RESTRICT,
  evidence_strength_policy_config_revision_id UUID REFERENCES config_revisions(id) ON DELETE RESTRICT,

  resolved_snapshot JSONB NOT NULL,

  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (workspace_id, snapshot_hash)
);

CREATE INDEX IF NOT EXISTS idx_workspace_policy_snapshots_workspace_created
  ON workspace_policy_snapshots(workspace_id, created_at DESC);

-- ============================================================================
-- 1b) Evidence-aware deterministic matching provenance (match runs)
-- ============================================================================

ALTER TABLE match_runs
  ADD COLUMN IF NOT EXISTS evidence_strength_policy_config_revision_id UUID REFERENCES config_revisions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS evidence_strength_policy_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_match_runs_evidence_strength_policy
  ON match_runs(workspace_id, evidence_strength_policy_hash);

-- ============================================================================
-- 2) Immutable deterministic decisions (audit + replay)
-- ============================================================================

CREATE TABLE IF NOT EXISTS deterministic_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
  job_version_id UUID NOT NULL REFERENCES job_versions(id) ON DELETE CASCADE,
  match_run_id UUID REFERENCES match_runs(id) ON DELETE SET NULL,
  policy_snapshot_id UUID NOT NULL REFERENCES workspace_policy_snapshots(id) ON DELETE RESTRICT,

  decision_hash TEXT NOT NULL,
  schema_version TEXT NOT NULL DEFAULT '2.2.0',
  decision_json JSONB NOT NULL,

  recommendation_eligibility TEXT NOT NULL CHECK (recommendation_eligibility IN ('ELIGIBLE', 'VERIFY', 'INELIGIBLE')),
  recommendation_outcome TEXT NOT NULL CHECK (recommendation_outcome IN ('PRIORITY', 'REVIEW', 'TRACK', 'SKIP')),

  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (workspace_id, canonical_job_id, job_version_id, policy_snapshot_id)
);

CREATE INDEX IF NOT EXISTS idx_deterministic_decisions_workspace_created
  ON deterministic_decisions(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deterministic_decisions_job_version_created
  ON deterministic_decisions(job_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deterministic_decisions_policy_snapshot_created
  ON deterministic_decisions(policy_snapshot_id, created_at DESC);

ALTER TABLE canonical_jobs
  ADD COLUMN IF NOT EXISTS latest_deterministic_decision_id UUID REFERENCES deterministic_decisions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_canonical_jobs_latest_deterministic_decision
  ON canonical_jobs(latest_deterministic_decision_id);

-- ============================================================================
-- 3) Immutability guards (never overwrite policy history)
-- ============================================================================

CREATE OR REPLACE FUNCTION workspace_policy_snapshots_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'workspace_policy_snapshots rows are immutable; insert a new snapshot instead.';
END
$$;

DROP TRIGGER IF EXISTS trg_workspace_policy_snapshots_immutable ON workspace_policy_snapshots;
CREATE TRIGGER trg_workspace_policy_snapshots_immutable
BEFORE UPDATE OR DELETE ON workspace_policy_snapshots
FOR EACH ROW EXECUTE FUNCTION workspace_policy_snapshots_immutable_guard();

CREATE OR REPLACE FUNCTION deterministic_decisions_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'deterministic_decisions rows are immutable; insert a new decision instead.';
END
$$;

DROP TRIGGER IF EXISTS trg_deterministic_decisions_immutable ON deterministic_decisions;
CREATE TRIGGER trg_deterministic_decisions_immutable
BEFORE UPDATE OR DELETE ON deterministic_decisions
FOR EACH ROW EXECUTE FUNCTION deterministic_decisions_immutable_guard();

COMMIT;
