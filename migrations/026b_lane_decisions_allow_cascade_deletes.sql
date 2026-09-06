-- Migration 026b: allow FK cascade deletes for lane_decisions
--
-- lane_decisions are immutable (no UPDATE; no direct DELETE), but must not block
-- parent teardown (workspace/job cleanup) via FK cascades.

CREATE OR REPLACE FUNCTION lane_decisions_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'lane_decisions rows are immutable; insert a new decision instead.';
END
$$;

