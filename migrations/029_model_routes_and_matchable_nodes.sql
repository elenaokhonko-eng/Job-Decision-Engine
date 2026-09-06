-- Migration 029: Model routes + invocation audit + matchable nodes view
--
-- Goals (IDE Closeout Pack P9):
-- 1) Versioned model routes by purpose/workspace.
-- 2) Invocation audit with least-data (hash/length metadata, not raw prompts).
-- 3) Expose published embeddings as "matchable nodes" for pgvector similarity queries.
--
-- Notes:
-- - Additive and reversible (no destructive drops).
-- - Designed to be optional: app code should tolerate missing tables pre-migration.

-- ============================================================================
-- 1) Model routes (stable identity + immutable revisions + activation audit)
-- ============================================================================

CREATE TABLE IF NOT EXISTS model_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  route_key TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('EVALUATION', 'EMBEDDING', 'DOCUMENT', 'EXTRACTION')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  description TEXT,
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, route_key)
);

CREATE INDEX IF NOT EXISTS idx_model_routes_workspace_purpose
  ON model_routes(workspace_id, purpose, status);

CREATE TABLE IF NOT EXISTS model_route_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_route_id UUID NOT NULL REFERENCES model_routes(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  schema_version TEXT NOT NULL DEFAULT '2.2.0',
  content_hash TEXT NOT NULL,
  content JSONB NOT NULL,
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_route_id, revision_number),
  UNIQUE (model_route_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_model_route_revisions_route
  ON model_route_revisions(model_route_id, created_at DESC);

CREATE OR REPLACE FUNCTION model_route_revisions_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'model_route_revisions rows are immutable; insert a new revision instead.';
END
$$;

DROP TRIGGER IF EXISTS trg_model_route_revisions_immutable ON model_route_revisions;
CREATE TRIGGER trg_model_route_revisions_immutable
BEFORE UPDATE OR DELETE ON model_route_revisions
FOR EACH ROW EXECUTE FUNCTION model_route_revisions_immutable_guard();

CREATE TABLE IF NOT EXISTS model_route_active_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_route_id UUID NOT NULL REFERENCES model_routes(id) ON DELETE CASCADE,
  model_route_revision_id UUID NOT NULL REFERENCES model_route_revisions(id) ON DELETE RESTRICT,
  activated_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_route_id)
);

CREATE INDEX IF NOT EXISTS idx_model_route_active_revisions_route
  ON model_route_active_revisions(model_route_id);

CREATE TABLE IF NOT EXISTS model_route_activation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_route_id UUID NOT NULL REFERENCES model_routes(id) ON DELETE CASCADE,
  from_revision_id UUID REFERENCES model_route_revisions(id) ON DELETE SET NULL,
  to_revision_id UUID REFERENCES model_route_revisions(id) ON DELETE SET NULL,
  activated_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_model_route_activation_events_route
  ON model_route_activation_events(model_route_id, activated_at DESC);

-- ============================================================================
-- 2) Invocation audit (least-data)
-- ============================================================================

CREATE TABLE IF NOT EXISTS model_route_invocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  model_route_id UUID REFERENCES model_routes(id) ON DELETE SET NULL,
  model_route_revision_id UUID REFERENCES model_route_revisions(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('EVALUATION', 'EMBEDDING', 'DOCUMENT', 'EXTRACTION')),

  provider TEXT,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'FAILED')),
  fallback_used BOOLEAN NOT NULL DEFAULT FALSE,

  request_hash TEXT NOT NULL,
  request_metadata JSONB,
  response_metadata JSONB,

  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  cost_usd NUMERIC(12,6),
  tokens_prompt INTEGER,
  tokens_completion INTEGER,
  tokens_total INTEGER,

  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_route_invocations_workspace_created
  ON model_route_invocations(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_model_route_invocations_workspace_purpose
  ON model_route_invocations(workspace_id, purpose, created_at DESC);

-- Optional link columns for downstream provenance (additive).
ALTER TABLE requirement_extraction_runs
  ADD COLUMN IF NOT EXISTS model_route_invocation_id UUID REFERENCES model_route_invocations(id) ON DELETE SET NULL;

ALTER TABLE evaluation_attempts
  ADD COLUMN IF NOT EXISTS model_route_invocation_id UUID REFERENCES model_route_invocations(id) ON DELETE SET NULL;

-- ============================================================================
-- 3) Published matchable nodes view (pgvector-backed)
-- ============================================================================

-- Replace the published-embeddings view to rely on batch-item completion, not the
-- semantic_embeddings.embedding_batch_id pointer. This supports atomic publication
-- even when an embedding already exists (ON CONFLICT DO NOTHING) and a new batch
-- is marking it as published.
CREATE OR REPLACE VIEW v_published_semantic_embeddings AS
  SELECT DISTINCT ON (se.workspace_id, se.embedding_space_id, se.embedding_input_id)
    se.*
  FROM semantic_embeddings se
  JOIN embedding_batches eb
    ON eb.workspace_id = se.workspace_id
   AND eb.embedding_space_id = se.embedding_space_id
  JOIN embedding_batch_items ebi
    ON ebi.workspace_id = eb.workspace_id
   AND ebi.embedding_batch_id = eb.id
   AND ebi.embedding_input_id = se.embedding_input_id
  WHERE eb.status = 'COMPLETED'
    AND ebi.status = 'COMPLETED'
  ORDER BY se.workspace_id, se.embedding_space_id, se.embedding_input_id, eb.completed_at DESC;

COMMENT ON VIEW v_published_semantic_embeddings IS
  'Semantic embeddings that are included as COMPLETED items in a COMPLETED batch; supports atomic publication without rewriting cached vectors.';

CREATE OR REPLACE VIEW v_matchable_nodes AS
  SELECT
    ei.workspace_id,
    ei.source_type AS node_type,
    ei.source_id AS node_id,
    ei.id AS embedding_input_id,
    ei.content_text,
    ei.content_hash,
    se.embedding_space_id,
    se.embedding_batch_id,
    se.vector_dimensions,
    se.embedding_values,
    se.embedding_vector,
    se.created_at AS embedded_at
  FROM embedding_inputs ei
  JOIN v_published_semantic_embeddings se
    ON se.workspace_id = ei.workspace_id
   AND se.embedding_input_id = ei.id;

COMMENT ON VIEW v_matchable_nodes IS
  'Published embeddings joined to their input identity (requirements/facts/lane prototypes) for similarity queries.';
