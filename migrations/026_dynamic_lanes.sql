-- Migration 026: Dynamic lanes (stable identities + immutable revisions)
--
-- Goals (IDE Closeout Pack P7):
-- 1) Stable lane identities per workspace (lane_key) with explicit ACTIVE/INACTIVE status.
-- 2) Immutable lane revisions storing full lane configuration content + hashes.
-- 3) Activation/audit events so the active revision can change without overwriting history.
-- 4) Separate user preference ordering from lane definitions.
-- 5) Persist immutable lane decisions with revision provenance for replay.
--
-- Notes:
-- - Additive and reversible (no destructive drops).
-- - Lane revisions are immutable; changes create a new revision and activate it.

BEGIN;

-- ============================================================================
-- 1) Stable lane identities
-- ============================================================================

CREATE TABLE IF NOT EXISTS lane_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lane_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, lane_key)
);

CREATE INDEX IF NOT EXISTS idx_lane_identities_workspace
  ON lane_identities(workspace_id);

-- ============================================================================
-- 2) Immutable lane revisions
-- ============================================================================

CREATE TABLE IF NOT EXISTS lane_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lane_identity_id UUID NOT NULL REFERENCES lane_identities(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  schema_version TEXT NOT NULL DEFAULT '2.2.0',
  content_hash TEXT NOT NULL,
  content JSONB NOT NULL,
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lane_identity_id, revision_number),
  UNIQUE (lane_identity_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_lane_revisions_identity_created
  ON lane_revisions(lane_identity_id, created_at DESC);

CREATE OR REPLACE FUNCTION lane_revisions_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'lane_revisions rows are immutable; insert a new revision instead.';
END
$$;

DROP TRIGGER IF EXISTS trg_lane_revisions_immutable ON lane_revisions;
CREATE TRIGGER trg_lane_revisions_immutable
BEFORE UPDATE OR DELETE ON lane_revisions
FOR EACH ROW EXECUTE FUNCTION lane_revisions_immutable_guard();

-- ============================================================================
-- 3) Active revision + activation audit
-- ============================================================================

CREATE TABLE IF NOT EXISTS lane_active_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lane_identity_id UUID NOT NULL REFERENCES lane_identities(id) ON DELETE CASCADE,
  lane_revision_id UUID NOT NULL REFERENCES lane_revisions(id) ON DELETE RESTRICT,
  activated_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lane_identity_id)
);

CREATE INDEX IF NOT EXISTS idx_lane_active_revisions_identity
  ON lane_active_revisions(lane_identity_id);

CREATE TABLE IF NOT EXISTS lane_activation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lane_identity_id UUID NOT NULL REFERENCES lane_identities(id) ON DELETE CASCADE,
  from_revision_id UUID REFERENCES lane_revisions(id) ON DELETE SET NULL,
  to_revision_id UUID REFERENCES lane_revisions(id) ON DELETE SET NULL,
  activated_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_lane_activation_events_identity
  ON lane_activation_events(lane_identity_id, activated_at DESC);

-- ============================================================================
-- 4) User lane preferences (ordering/enablement separate from lane definitions)
-- ============================================================================

CREATE TABLE IF NOT EXISTS workspace_lane_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workspace_user_id UUID NOT NULL REFERENCES workspace_users(id) ON DELETE CASCADE,
  lane_identity_id UUID NOT NULL REFERENCES lane_identities(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority_rank INTEGER NOT NULL DEFAULT 1000 CHECK (priority_rank >= 0),
  priority_weight DOUBLE PRECISION CHECK (priority_weight IS NULL OR (priority_weight >= 0 AND priority_weight <= 1)),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_user_id, lane_identity_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_lane_preferences_user_rank
  ON workspace_lane_preferences(workspace_user_id, enabled, priority_rank ASC);

CREATE INDEX IF NOT EXISTS idx_workspace_lane_preferences_workspace_lane
  ON workspace_lane_preferences(workspace_id, lane_identity_id);

-- ============================================================================
-- 5) Immutable lane decisions (audit + replay pinned to lane revisions)
-- ============================================================================

CREATE TABLE IF NOT EXISTS lane_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
  job_version_id UUID NOT NULL REFERENCES job_versions(id) ON DELETE CASCADE,

  decision_hash TEXT NOT NULL,
  schema_version TEXT NOT NULL DEFAULT '2.2.0',
  model_version TEXT NOT NULL,
  lane_snapshot JSONB NOT NULL,
  decision_json JSONB NOT NULL,

  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (workspace_id, decision_hash)
);

CREATE INDEX IF NOT EXISTS idx_lane_decisions_workspace_created
  ON lane_decisions(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lane_decisions_job_version_created
  ON lane_decisions(job_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lane_decisions_job_created
  ON lane_decisions(canonical_job_id, created_at DESC);

ALTER TABLE canonical_jobs
  ADD COLUMN IF NOT EXISTS latest_lane_decision_id UUID REFERENCES lane_decisions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_canonical_jobs_latest_lane_decision
  ON canonical_jobs(latest_lane_decision_id);

CREATE OR REPLACE FUNCTION lane_decisions_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'lane_decisions rows are immutable; insert a new decision instead.';
END
$$;

DROP TRIGGER IF EXISTS trg_lane_decisions_immutable ON lane_decisions;
CREATE TRIGGER trg_lane_decisions_immutable
BEFORE UPDATE OR DELETE ON lane_decisions
FOR EACH ROW EXECUTE FUNCTION lane_decisions_immutable_guard();

COMMIT;
