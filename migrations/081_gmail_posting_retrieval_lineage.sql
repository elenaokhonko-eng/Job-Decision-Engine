-- Migration 081: link retrieved employer postings to their Gmail discovery observations.
--
-- This migration is additive. It preserves the original Gmail observation and stores
-- employer content in a separate raw observation that points back to its discovery.
-- Rollback requires preserving the derived_from_observation_id values before dropping
-- the column; no observation or version is deleted by this migration.

ALTER TABLE raw_job_observations
  ADD COLUMN IF NOT EXISTS derived_from_observation_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'raw_job_observations'::regclass
      AND conname = 'raw_job_observations_derived_from_workspace_fk'
  ) THEN
    ALTER TABLE raw_job_observations
      ADD CONSTRAINT raw_job_observations_derived_from_workspace_fk
      FOREIGN KEY (workspace_id, derived_from_observation_id)
      REFERENCES raw_job_observations (workspace_id, id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_raw_job_observations_derived_from
  ON raw_job_observations (workspace_id, derived_from_observation_id)
  WHERE derived_from_observation_id IS NOT NULL;

COMMENT ON COLUMN raw_job_observations.derived_from_observation_id IS
  'Tenant-scoped lineage to the immutable discovery observation that caused this retrieved source snapshot.';
