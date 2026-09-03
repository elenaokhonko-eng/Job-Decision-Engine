-- Migration 014: Embedding spaces and batch execution foundation
--
-- Purpose:
-- 1. Register embedding spaces (provider/model/dimensions/metric).
-- 2. Store embedding inputs keyed by source identity.
-- 3. Track batch execution state and failures.
-- 4. Persist vectors with per-space provenance.

BEGIN;

CREATE TABLE IF NOT EXISTS embedding_spaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    space_key TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL CHECK (dimensions > 0),
    normalization TEXT NOT NULL DEFAULT 'L2',
    distance_metric TEXT NOT NULL DEFAULT 'COSINE' CHECK (distance_metric IN ('COSINE', 'DOT', 'L2')),
    is_fallback_space BOOLEAN NOT NULL DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS embedding_inputs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    input_key TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL CHECK (source_type IN ('PROFILE_FACT', 'JOB_REQUIREMENT', 'LANE_PROTOTYPE')),
    source_id UUID NOT NULL,
    content_text TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_embedding_inputs_source ON embedding_inputs(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_embedding_inputs_hash ON embedding_inputs(content_hash);

CREATE TABLE IF NOT EXISTS embedding_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    embedding_space_id UUID NOT NULL REFERENCES embedding_spaces(id) ON DELETE RESTRICT,
    batch_key TEXT NOT NULL UNIQUE,
    run_type TEXT NOT NULL CHECK (run_type IN ('PRIMARY', 'FALLBACK')),
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
    item_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_embedding_batches_space_status ON embedding_batches(embedding_space_id, status);

CREATE TABLE IF NOT EXISTS semantic_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    embedding_space_id UUID NOT NULL REFERENCES embedding_spaces(id) ON DELETE RESTRICT,
    embedding_input_id UUID NOT NULL REFERENCES embedding_inputs(id) ON DELETE CASCADE,
    embedding_batch_id UUID REFERENCES embedding_batches(id) ON DELETE SET NULL,
    vector_dimensions INTEGER NOT NULL CHECK (vector_dimensions > 0),
    embedding_values DOUBLE PRECISION[] NOT NULL,
    vector_checksum TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (embedding_space_id, embedding_input_id)
);

CREATE INDEX IF NOT EXISTS idx_semantic_embeddings_space_input ON semantic_embeddings(embedding_space_id, embedding_input_id);

COMMENT ON TABLE embedding_spaces IS
  'Registry of embedding spaces; one provider/model/dimension configuration per space.';

COMMENT ON TABLE embedding_inputs IS
  'Provider-independent cache of embedding text keyed by source identity.';

COMMENT ON TABLE embedding_batches IS
  'Batch execution ledger for embedding generation with success/failure counts.';

COMMENT ON TABLE semantic_embeddings IS
  'Persisted vectors with immutable input hash lineage and embedding space provenance.';

COMMIT;
