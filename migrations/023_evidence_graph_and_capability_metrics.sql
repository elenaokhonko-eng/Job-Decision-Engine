-- Migration 023: Evidence graph edges/spans + deterministic capability metric snapshots
--
-- Goals (IDE Closeout Pack P4):
-- 1) Introduce a typed evidence-edge ledger (graph foundation) with optional source spans.
-- 2) Persist immutable, deterministic capability metric snapshots with calculation trace.
--
-- Notes:
-- - Additive and reversible (no drops of user data).
-- - Existing edge tables (profile_fact_concepts, profile_fact_evidence_sources) remain authoritative;
--   this migration backfills them into a generic evidence_edges table for graph queries.

BEGIN;

-- ============================================================================
-- 1) Evidence spans (optional excerpt/offset/page pointers)
-- ============================================================================

CREATE TABLE IF NOT EXISTS evidence_spans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  evidence_source_id UUID NOT NULL REFERENCES evidence_sources(id) ON DELETE CASCADE,
  span_type TEXT NOT NULL DEFAULT 'TEXT' CHECK (span_type IN ('TEXT', 'URL_FRAGMENT', 'PDF_PAGE', 'UNKNOWN')),
  start_offset INTEGER,
  end_offset INTEGER,
  page_number INTEGER,
  excerpt TEXT,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (evidence_source_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_evidence_spans_workspace ON evidence_spans(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_spans_source ON evidence_spans(evidence_source_id, created_at DESC);

-- ============================================================================
-- 2) Typed evidence edges (generic graph foundation)
-- ============================================================================

CREATE TABLE IF NOT EXISTS evidence_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL CHECK (
    edge_type IN (
      'FACT_SUPPORTS_CONCEPT',
      'FACT_ATTRIBUTED_TO_SOURCE'
    )
  ),
  from_entity_type TEXT NOT NULL CHECK (from_entity_type IN ('PROFILE_FACT')),
  from_entity_id UUID NOT NULL,
  to_entity_type TEXT NOT NULL CHECK (to_entity_type IN ('TAXONOMY_CONCEPT', 'EVIDENCE_SOURCE')),
  to_entity_id UUID NOT NULL,
  relationship TEXT,
  evidence_span_id UUID REFERENCES evidence_spans(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, edge_type, from_entity_type, from_entity_id, to_entity_type, to_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_evidence_edges_from
  ON evidence_edges(workspace_id, from_entity_type, from_entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_edges_to
  ON evidence_edges(workspace_id, to_entity_type, to_entity_id, created_at DESC);

-- Backfill from existing specific edge tables.
INSERT INTO evidence_edges (
  workspace_id,
  edge_type,
  from_entity_type,
  from_entity_id,
  to_entity_type,
  to_entity_id,
  relationship
)
SELECT
  pfc.workspace_id,
  'FACT_SUPPORTS_CONCEPT',
  'PROFILE_FACT',
  pfc.profile_fact_id,
  'TAXONOMY_CONCEPT',
  pfc.concept_id,
  pfc.evidence_relationship
FROM profile_fact_concepts pfc
ON CONFLICT (workspace_id, edge_type, from_entity_type, from_entity_id, to_entity_type, to_entity_id) DO NOTHING;

INSERT INTO evidence_edges (
  workspace_id,
  edge_type,
  from_entity_type,
  from_entity_id,
  to_entity_type,
  to_entity_id,
  relationship
)
SELECT
  pfes.workspace_id,
  'FACT_ATTRIBUTED_TO_SOURCE',
  'PROFILE_FACT',
  pfes.profile_fact_id,
  'EVIDENCE_SOURCE',
  pfes.evidence_source_id,
  'ATTRIBUTED_TO'
FROM profile_fact_evidence_sources pfes
ON CONFLICT (workspace_id, edge_type, from_entity_type, from_entity_id, to_entity_type, to_entity_id) DO NOTHING;

-- ============================================================================
-- 3) Immutable capability metric snapshots per (profile_version, concept, as_of_date)
-- ============================================================================

CREATE TABLE IF NOT EXISTS profile_concept_metric_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_version_id UUID NOT NULL REFERENCES profile_versions(id) ON DELETE CASCADE,
  concept_id UUID NOT NULL REFERENCES taxonomy_concepts(id) ON DELETE RESTRICT,
  as_of_date DATE NOT NULL,
  schema_version TEXT NOT NULL DEFAULT '2.2.0',
  metric_policy_version TEXT NOT NULL DEFAULT 'capability_metrics_v1',
  metrics_hash TEXT NOT NULL,
  metrics JSONB NOT NULL,
  trace JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_version_id, concept_id, as_of_date, metric_policy_version, metrics_hash)
);

CREATE INDEX IF NOT EXISTS idx_profile_concept_metric_snapshots_workspace
  ON profile_concept_metric_snapshots(workspace_id, as_of_date DESC);
CREATE INDEX IF NOT EXISTS idx_profile_concept_metric_snapshots_profile
  ON profile_concept_metric_snapshots(profile_version_id, concept_id, as_of_date DESC);

CREATE OR REPLACE FUNCTION profile_concept_metric_snapshots_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'profile_concept_metric_snapshots rows are immutable; insert a new snapshot instead.';
END
$$;

DROP TRIGGER IF EXISTS trg_profile_concept_metric_snapshots_immutable ON profile_concept_metric_snapshots;
CREATE TRIGGER trg_profile_concept_metric_snapshots_immutable
BEFORE UPDATE OR DELETE ON profile_concept_metric_snapshots
FOR EACH ROW EXECUTE FUNCTION profile_concept_metric_snapshots_immutable_guard();

COMMIT;

