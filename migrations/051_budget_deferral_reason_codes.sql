-- Migration 051: Preserve explicit audit evidence for unconfigured lanes.
--
-- A lane without a configured AI budget is capacity zero, not a missing job.
-- Existing deferral history remains valid and is not rewritten.

ALTER TABLE evaluation_budget_deferrals
  DROP CONSTRAINT IF EXISTS evaluation_budget_deferrals_reason_code_check,
  DROP CONSTRAINT IF EXISTS evaluation_budget_deferrals_reason_code_chk;

ALTER TABLE evaluation_budget_deferrals
  ADD CONSTRAINT evaluation_budget_deferrals_reason_code_chk
  CHECK (
    reason_code IN ('AI_BUDGET_EXHAUSTED', 'AI_BUDGET_UNCONFIGURED_LANE')
  );
