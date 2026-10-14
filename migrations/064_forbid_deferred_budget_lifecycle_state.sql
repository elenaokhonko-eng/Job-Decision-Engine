-- Migration 064: Forbid DEFERRED_BUDGET as a canonical lifecycle state.
--
-- Budget deferrals remain auditable in evaluation_budget_deferrals. Canonical
-- jobs must stay in an artifact-supported state so budget capacity cannot create
-- a hidden career-state pool.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'canonical_jobs_no_deferred_budget_state_chk'
      AND conrelid = 'canonical_jobs'::regclass
  ) THEN
    ALTER TABLE canonical_jobs
      ADD CONSTRAINT canonical_jobs_no_deferred_budget_state_chk
      CHECK (
        processing_state <> 'DEFERRED_BUDGET'
        AND (processing_status IS NULL OR processing_status <> 'DEFERRED_BUDGET')
      );
  END IF;
END $$;
