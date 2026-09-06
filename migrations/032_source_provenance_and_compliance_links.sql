-- Migration 032: Source provenance/compliance links for observations
--
-- Goals (P12):
-- 1) Link every raw observation to an immutable source plugin revision (for later compliance audits).
-- 2) Preserve the source_key used at ingestion time (join key for compliance matrix + health reporting).
--
-- Notes:
-- - Additive and reversible (no destructive drops).
-- - Column is nullable to allow phased backfill; runtime should set it for new ingestions.

BEGIN;

ALTER TABLE raw_job_observations
  ADD COLUMN IF NOT EXISTS source_plugin_key TEXT;

ALTER TABLE raw_job_observations
  ADD COLUMN IF NOT EXISTS source_plugin_revision_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'raw_job_observations'
      AND constraint_name = 'fk_raw_job_observations_source_plugin_revision'
  ) THEN
    ALTER TABLE raw_job_observations
      ADD CONSTRAINT fk_raw_job_observations_source_plugin_revision
      FOREIGN KEY (source_plugin_revision_id)
      REFERENCES source_plugin_revisions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Backfill best-effort keys for existing rows (revision id is set by runtime once registry is seeded).
UPDATE raw_job_observations
SET source_plugin_key = lower(source_name)
WHERE source_plugin_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_raw_job_observations_source_plugin_key
  ON raw_job_observations(workspace_id, source_plugin_key, retrieved_at DESC);

CREATE INDEX IF NOT EXISTS idx_raw_job_observations_source_plugin_revision
  ON raw_job_observations(source_plugin_revision_id);

COMMIT;

