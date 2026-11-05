-- Migration 089: pin the lane registry snapshot used by each AI budget run.
--
-- A worker invocation shares one budget-run identity across its explanation
-- tasks. Persisting the exact lane source, aggregate version, hash, and per-lane
-- limits prevents that run from mixing registry revisions. Later invocations
-- use new budget-run identities.

ALTER TABLE ai_evaluation_budget_runs
  ADD COLUMN lane_config_source TEXT,
  ADD COLUMN lane_config_version TEXT,
  ADD COLUMN lane_config_hash TEXT,
  ADD COLUMN lane_config_snapshot JSONB;

ALTER TABLE ai_evaluation_budget_runs
  ADD CONSTRAINT ai_evaluation_budget_runs_lane_config_snapshot_check
  CHECK (
    (lane_config_source IS NULL
      AND lane_config_version IS NULL
      AND lane_config_hash IS NULL
      AND lane_config_snapshot IS NULL)
    OR
    (lane_config_source IS NOT NULL
      AND lane_config_source IN ('LANE_REGISTRY_DB', 'FILES')
      AND lane_config_version IS NOT NULL
      AND lane_config_hash IS NOT NULL
      AND lane_config_hash ~ '^[0-9a-f]{64}$'
      AND lane_config_snapshot IS NOT NULL
      AND jsonb_typeof(lane_config_snapshot) = 'object')
  );

COMMENT ON COLUMN ai_evaluation_budget_runs.lane_config_snapshot IS
  'Immutable source, version, and per-lane AI caps pinned on the first enqueue attempt for this budget run.';

CREATE OR REPLACE FUNCTION prevent_ai_evaluation_budget_snapshot_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.lane_config_snapshot IS NOT NULL AND (
    NEW.lane_config_source IS DISTINCT FROM OLD.lane_config_source
    OR NEW.lane_config_version IS DISTINCT FROM OLD.lane_config_version
    OR NEW.lane_config_hash IS DISTINCT FROM OLD.lane_config_hash
    OR NEW.lane_config_snapshot IS DISTINCT FROM OLD.lane_config_snapshot
  ) THEN
    RAISE EXCEPTION 'AI evaluation budget run lane configuration snapshots are immutable.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ai_evaluation_budget_snapshot_immutable
BEFORE UPDATE ON ai_evaluation_budget_runs
FOR EACH ROW EXECUTE FUNCTION prevent_ai_evaluation_budget_snapshot_rewrite();
