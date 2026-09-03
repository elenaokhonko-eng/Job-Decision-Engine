-- Migration 014b: Embedding manifest tracking and fallback lineage
--
-- Adds per-item manifest tracking for partial failures and fallback reruns.

BEGIN;

ALTER TABLE embedding_batches
  ADD COLUMN IF NOT EXISTS fallback_from_batch_id UUID REFERENCES embedding_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rerun_of_batch_id UUID REFERENCES embedding_batches(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS embedding_batch_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    embedding_batch_id UUID NOT NULL REFERENCES embedding_batches(id) ON DELETE CASCADE,
    embedding_input_id UUID NOT NULL REFERENCES embedding_inputs(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED', 'SKIPPED')),
    attempt_count INTEGER NOT NULL DEFAULT 1,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (embedding_batch_id, embedding_input_id)
);

CREATE INDEX IF NOT EXISTS idx_embedding_batch_items_batch_status
  ON embedding_batch_items(embedding_batch_id, status);

CREATE INDEX IF NOT EXISTS idx_embedding_batch_items_input
  ON embedding_batch_items(embedding_input_id);

COMMENT ON TABLE embedding_batch_items IS
  'Per-item embedding manifest rows for completion/failure tracking and fallback reruns.';

COMMIT;
