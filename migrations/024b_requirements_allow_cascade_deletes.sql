-- Migration 024b: allow FK cascade deletes for immutable requirements tables
--
-- requirement_sets and job_requirements are immutable (no UPDATE; no direct DELETE).
-- However, canonical job or workspace teardown (and dev/test cleanup) must be able to
-- cascade-delete dependent rows without being blocked by immutability guards.

CREATE OR REPLACE FUNCTION requirement_sets_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'requirement_sets rows are immutable; insert a new requirement_set revision instead.';
END
$$;

CREATE OR REPLACE FUNCTION job_requirements_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'job_requirements rows are immutable; insert new rows under a new requirement_set_id instead.';
END
$$;

