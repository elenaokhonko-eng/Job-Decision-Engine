-- Migration 025b: allow FK cascade deletes for deterministic_decisions
--
-- deterministic_decisions are immutable (no UPDATE; no direct DELETE).
-- However, foreign-key cascades (e.g., deleting a canonical job during dev/test cleanup,
-- or deleting a workspace) must be able to remove dependent decision rows.
--
-- We detect cascades via pg_trigger_depth(): FK cascades execute deletes inside a trigger,
-- so depth will be > 1 when this trigger fires.

CREATE OR REPLACE FUNCTION deterministic_decisions_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'deterministic_decisions rows are immutable; insert a new decision instead.';
END
$$;

