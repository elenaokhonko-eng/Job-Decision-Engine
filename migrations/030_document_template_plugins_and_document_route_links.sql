-- Migration 030: Document template plugins + document run linkage to model routes
--
-- Goals (IDE Closeout Pack P9):
-- 1) Declarative document template plugins with immutable revisions.
-- 2) Persist which plugin revision and model-route invocation produced a document run.
--
-- Notes:
-- - Additive and reversible (no destructive drops).
-- - Does not change existing generators; code can adopt these tables gradually.

BEGIN;

-- ============================================================================
-- 1) Document template plugin registry (stable identity + immutable revisions)
-- ============================================================================

CREATE TABLE IF NOT EXISTS document_template_plugins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plugin_key TEXT NOT NULL,
  document_type TEXT NOT NULL CHECK (document_type IN ('CV', 'COVER_LETTER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  description TEXT,
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, plugin_key)
);

CREATE INDEX IF NOT EXISTS idx_document_template_plugins_workspace_type
  ON document_template_plugins(workspace_id, document_type, status);

CREATE TABLE IF NOT EXISTS document_template_plugin_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id UUID NOT NULL REFERENCES document_template_plugins(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  schema_version TEXT NOT NULL DEFAULT '2.2.0',
  content_hash TEXT NOT NULL,
  content JSONB NOT NULL,
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (plugin_id, revision_number),
  UNIQUE (plugin_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_document_template_plugin_revisions_plugin
  ON document_template_plugin_revisions(plugin_id, created_at DESC);

CREATE OR REPLACE FUNCTION document_template_plugin_revisions_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'document_template_plugin_revisions rows are immutable; insert a new revision instead.';
END
$$;

DROP TRIGGER IF EXISTS trg_document_template_plugin_revisions_immutable ON document_template_plugin_revisions;
CREATE TRIGGER trg_document_template_plugin_revisions_immutable
BEFORE UPDATE OR DELETE ON document_template_plugin_revisions
FOR EACH ROW EXECUTE FUNCTION document_template_plugin_revisions_immutable_guard();

CREATE TABLE IF NOT EXISTS document_template_plugin_active_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id UUID NOT NULL REFERENCES document_template_plugins(id) ON DELETE CASCADE,
  plugin_revision_id UUID NOT NULL REFERENCES document_template_plugin_revisions(id) ON DELETE RESTRICT,
  activated_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (plugin_id)
);

CREATE INDEX IF NOT EXISTS idx_document_template_plugin_active_revisions_plugin
  ON document_template_plugin_active_revisions(plugin_id);

CREATE TABLE IF NOT EXISTS document_template_plugin_activation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id UUID NOT NULL REFERENCES document_template_plugins(id) ON DELETE CASCADE,
  from_revision_id UUID REFERENCES document_template_plugin_revisions(id) ON DELETE SET NULL,
  to_revision_id UUID REFERENCES document_template_plugin_revisions(id) ON DELETE SET NULL,
  activated_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_document_template_plugin_activation_events_plugin
  ON document_template_plugin_activation_events(plugin_id, activated_at DESC);

-- ============================================================================
-- 2) Link document runs to model-route invocations + plugin revisions
-- ============================================================================

ALTER TABLE document_runs
  ADD COLUMN IF NOT EXISTS model_route_invocation_id UUID REFERENCES model_route_invocations(id) ON DELETE SET NULL;

ALTER TABLE document_runs
  ADD COLUMN IF NOT EXISTS document_template_plugin_revision_id UUID REFERENCES document_template_plugin_revisions(id) ON DELETE SET NULL;

ALTER TABLE document_runs
  ADD COLUMN IF NOT EXISTS document_template_plugin_key TEXT;

CREATE INDEX IF NOT EXISTS idx_document_runs_route_invocation
  ON document_runs(model_route_invocation_id);

CREATE INDEX IF NOT EXISTS idx_document_runs_template_revision
  ON document_runs(document_template_plugin_revision_id);

COMMIT;

