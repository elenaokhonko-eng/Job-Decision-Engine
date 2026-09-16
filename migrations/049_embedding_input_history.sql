-- Migration 049: Preserve embedding-input history and publish current inputs only
--
-- Embedding input content can change while its source identity remains stable.
-- Keep each generated input for auditability, and make exactly one input per
-- workspace/source the current row consumed by embedding workers and matchers.

ALTER TABLE embedding_inputs
  ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

-- Existing rows predate currentness tracking. Keep all rows, and retain the
-- newest row as current if a legacy database contains duplicate source rows.
WITH ranked_inputs AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY workspace_id, source_type, source_id
      ORDER BY created_at DESC, id DESC
    ) AS row_number
  FROM embedding_inputs
)
UPDATE embedding_inputs ei
SET is_current = ranked_inputs.row_number = 1,
    superseded_at = CASE
      WHEN ranked_inputs.row_number = 1 THEN NULL
      ELSE COALESCE(ei.superseded_at, NOW())
    END
FROM ranked_inputs
WHERE ranked_inputs.id = ei.id;

-- Migration 020 enforced source-level uniqueness. Replace it with current-row
-- uniqueness so superseded inputs remain queryable and recoverable.
ALTER TABLE embedding_inputs
  DROP CONSTRAINT IF EXISTS embedding_inputs_source_type_source_id_key;

DROP INDEX IF EXISTS idx_embedding_inputs_workspace_source;

CREATE UNIQUE INDEX IF NOT EXISTS idx_embedding_inputs_workspace_source_current
  ON embedding_inputs (workspace_id, source_type, source_id)
  WHERE is_current = TRUE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'embedding_inputs_current_superseded_check'
      AND conrelid = 'embedding_inputs'::regclass
  ) THEN
    ALTER TABLE embedding_inputs
      ADD CONSTRAINT embedding_inputs_current_superseded_check
      CHECK (
        (is_current = TRUE AND superseded_at IS NULL)
        OR (is_current = FALSE AND superseded_at IS NOT NULL)
      );
  END IF;
END $$;

-- Keep historical vectors stored, but do not expose vectors whose input has
-- been superseded through published matching views.
CREATE OR REPLACE VIEW v_published_semantic_embeddings AS
  SELECT DISTINCT ON (se.workspace_id, se.embedding_space_id, se.embedding_input_id)
    se.*
  FROM semantic_embeddings se
  JOIN embedding_inputs ei
    ON ei.workspace_id = se.workspace_id
   AND ei.id = se.embedding_input_id
   AND ei.is_current = TRUE
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
  'Semantic embeddings included as COMPLETED items in a COMPLETED batch for current embedding inputs only.';

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
   AND se.embedding_input_id = ei.id
  WHERE ei.is_current = TRUE;

COMMENT ON VIEW v_matchable_nodes IS
  'Published embeddings joined to current embedding inputs for similarity queries.';
