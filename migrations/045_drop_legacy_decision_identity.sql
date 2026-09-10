-- Migration 045: remove the legacy deterministic-decision identity
--
-- Migration 041 introduced context_fingerprint, but its historical constraint
-- name did not match PostgreSQL's generated name on every database. Some
-- environments therefore retained both unique identities. The legacy
-- four-column identity prevents a new decision for a changed match/profile
-- context and turns a valid replay into a retryable database failure.
-- Preserve every decision row; only replace the obsolete uniqueness rule.

DO $$
DECLARE
  legacy_constraint RECORD;
BEGIN
  FOR legacy_constraint IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'deterministic_decisions'::regclass
      AND c.contype = 'u'
      AND c.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'workspace_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'canonical_job_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'job_version_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'policy_snapshot_id')
      ]::smallint[]
  LOOP
    EXECUTE format(
      'ALTER TABLE deterministic_decisions DROP CONSTRAINT %I',
      legacy_constraint.conname
    );
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'deterministic_decisions'::regclass
      AND conname = 'deterministic_decisions_workspace_job_version_policy_context_key'
  ) THEN
    ALTER TABLE deterministic_decisions
      ADD CONSTRAINT deterministic_decisions_workspace_job_version_policy_context_key
      UNIQUE (workspace_id, canonical_job_id, job_version_id, policy_snapshot_id, context_fingerprint);
  END IF;
END $$;

COMMENT ON CONSTRAINT deterministic_decisions_workspace_job_version_policy_context_key
  ON deterministic_decisions IS
  'Decision identity includes the full current artifact context; historical rows remain immutable.';
