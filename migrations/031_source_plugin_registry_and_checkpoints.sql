-- Migration 031: Source plugin registry and checkpoints
--
-- Goals (P12):
-- 1) Versioned, workspace-scoped source plugin manifests (definitions -> immutable revisions -> activation).
-- 2) Connector account registry (stores only secret-key references; never secret values).
-- 3) Checkpoint storage for incremental pagination/cursors (per plugin + optional connector account).
--
-- Notes:
-- - Additive and reversible (no destructive drops).
-- - Runtime may load manifests from disk and/or seed via scripts into this registry.

-- ============================================================================
-- 1) Source plugins (workspace-scoped)
-- ============================================================================

CREATE TABLE IF NOT EXISTS source_plugins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ats', 'json_api', 'rss', 'atom', 'schema_org', 'email_alert', 'manual_import')),
  status TEXT NOT NULL CHECK (status IN ('active', 'experimental', 'disabled', 'deprecated')),
  schema_version TEXT NOT NULL DEFAULT '2.2.0',
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, source_key)
);

CREATE INDEX IF NOT EXISTS idx_source_plugins_workspace
  ON source_plugins(workspace_id, status, source_key);

-- ============================================================================
-- 2) Immutable source plugin revisions (content-addressed)
-- ============================================================================

CREATE TABLE IF NOT EXISTS source_plugin_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_plugin_id UUID NOT NULL REFERENCES source_plugins(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  schema_version TEXT NOT NULL DEFAULT '2.2.0',
  content_hash TEXT NOT NULL,
  content JSONB NOT NULL,
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_plugin_id, revision_number),
  UNIQUE (source_plugin_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_source_plugin_revisions_plugin
  ON source_plugin_revisions(source_plugin_id, created_at DESC);

CREATE OR REPLACE FUNCTION source_plugin_revisions_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'source_plugin_revisions rows are immutable; insert a new revision instead.';
END
$$;

DROP TRIGGER IF EXISTS trg_source_plugin_revisions_immutable ON source_plugin_revisions;
CREATE TRIGGER trg_source_plugin_revisions_immutable
BEFORE UPDATE OR DELETE ON source_plugin_revisions
FOR EACH ROW EXECUTE FUNCTION source_plugin_revisions_immutable_guard();

-- Active revision pointer + activation audit event surface.
CREATE TABLE IF NOT EXISTS source_plugin_active_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_plugin_id UUID NOT NULL REFERENCES source_plugins(id) ON DELETE CASCADE,
  source_plugin_revision_id UUID NOT NULL REFERENCES source_plugin_revisions(id) ON DELETE RESTRICT,
  activated_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_plugin_id)
);

CREATE INDEX IF NOT EXISTS idx_source_plugin_active_revisions_plugin
  ON source_plugin_active_revisions(source_plugin_id, activated_at DESC);

-- ============================================================================
-- 3) Connector accounts (secret references only) + checkpoints
-- ============================================================================

CREATE TABLE IF NOT EXISTS source_connector_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_plugin_id UUID NOT NULL REFERENCES source_plugins(id) ON DELETE CASCADE,
  account_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  -- e.g. ["GMAIL_OAUTH_REFRESH_TOKEN", "SOME_BEARER_TOKEN_ENV_KEY"] (never store secret values).
  secret_key_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_plugin_id, account_key)
);

CREATE INDEX IF NOT EXISTS idx_source_connector_accounts_workspace
  ON source_connector_accounts(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS source_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_plugin_id UUID NOT NULL REFERENCES source_plugins(id) ON DELETE CASCADE,
  connector_account_id UUID REFERENCES source_connector_accounts(id) ON DELETE CASCADE,
  checkpoint_key TEXT NOT NULL,
  checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforce one "default" checkpoint per plugin/key when connector_account_id is NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_checkpoints_default
  ON source_checkpoints(source_plugin_id, checkpoint_key)
  WHERE connector_account_id IS NULL;

-- Enforce one checkpoint per account/key when connector_account_id is NOT NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_checkpoints_account
  ON source_checkpoints(connector_account_id, checkpoint_key)
  WHERE connector_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_source_checkpoints_workspace
  ON source_checkpoints(workspace_id, source_plugin_id, updated_at DESC);
