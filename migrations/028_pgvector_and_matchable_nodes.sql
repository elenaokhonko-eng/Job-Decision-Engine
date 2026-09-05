-- Migration 028: pgvector + matchable nodes + embedding publication helpers
--
-- Goals (IDE Closeout Pack P8):
-- 1) Enable pgvector-backed similarity queries for persisted embeddings.
-- 2) Provide a published-embeddings view to support atomic batch publication semantics.
--
-- Notes:
-- - Requires a Postgres image/build with the pgvector extension available.
-- - Additive and reversible (no destructive drops).

BEGIN;

-- 1) pgvector extension (required for vector-typed columns and similarity ops)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2) Add vector column to semantic_embeddings (keeps existing double precision[] for backwards compatibility)
ALTER TABLE semantic_embeddings
  ADD COLUMN IF NOT EXISTS embedding_vector vector;

-- Best-effort backfill for existing rows (safe if empty)
DO $$
BEGIN
  BEGIN
    UPDATE semantic_embeddings
    SET embedding_vector = embedding_values::vector
    WHERE embedding_vector IS NULL;
  EXCEPTION WHEN undefined_function THEN
    -- Casting may not be available on older pgvector builds; leave NULL and let writers populate.
    NULL;
  END;
END $$;

-- 3) Batch publication metadata
ALTER TABLE embedding_batches
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS publication_note TEXT;

-- 4) Published embeddings view: consumers can require batch COMPLETED to avoid partial publication.
CREATE OR REPLACE VIEW v_published_semantic_embeddings AS
  SELECT
    se.*
  FROM semantic_embeddings se
  JOIN embedding_batches eb
    ON eb.id = se.embedding_batch_id
   AND eb.workspace_id = se.workspace_id
  WHERE eb.status = 'COMPLETED';

COMMENT ON VIEW v_published_semantic_embeddings IS
  'Semantic embeddings that belong to a COMPLETED batch; intended for coherent comparisons and atomic publication.';

COMMIT;

