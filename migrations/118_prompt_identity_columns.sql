-- Migration 118: nullable prompt id and prompt version on evaluations and document runs.
--
-- A stored evaluation or generated document should say which prompt produced it, so a change of
-- prompt wording can be traced to a change of results. The prompt registry that will fill these
-- columns waits for the model gateway (workstream W5); until then nothing writes them and every
-- row, old and new, keeps NULL. No value is backfilled or guessed.
--
--   prompt_id      stable name of the prompt, for example 'job_evaluation'.
--   prompt_version version of that prompt as the registry records it.
--
-- The pair is set together or not at all, so a row never names a prompt without its version.
--
-- Tables: ai_evaluations (evaluations), document_runs (CV and cover letter provenance, migration 016),
-- manual_application_document_runs (manual application documents, migration 082).
--
-- Additive only: three tables each gain two nullable columns and one check constraint. No default,
-- no rewrite of existing rows, no view or index changes.
--
-- Rollback (removes only these columns; human approval required if the registry has filled them):
--   ALTER TABLE ai_evaluations DROP CONSTRAINT IF EXISTS ai_evaluations_prompt_pair_chk;
--   ALTER TABLE ai_evaluations DROP COLUMN IF EXISTS prompt_id, DROP COLUMN IF EXISTS prompt_version;
--   ALTER TABLE document_runs DROP CONSTRAINT IF EXISTS document_runs_prompt_pair_chk;
--   ALTER TABLE document_runs DROP COLUMN IF EXISTS prompt_id, DROP COLUMN IF EXISTS prompt_version;
--   ALTER TABLE manual_application_document_runs DROP CONSTRAINT IF EXISTS manual_application_document_runs_prompt_pair_chk;
--   ALTER TABLE manual_application_document_runs DROP COLUMN IF EXISTS prompt_id, DROP COLUMN IF EXISTS prompt_version;

ALTER TABLE ai_evaluations
  ADD COLUMN IF NOT EXISTS prompt_id TEXT,
  ADD COLUMN IF NOT EXISTS prompt_version TEXT;

ALTER TABLE document_runs
  ADD COLUMN IF NOT EXISTS prompt_id TEXT,
  ADD COLUMN IF NOT EXISTS prompt_version TEXT;

ALTER TABLE manual_application_document_runs
  ADD COLUMN IF NOT EXISTS prompt_id TEXT,
  ADD COLUMN IF NOT EXISTS prompt_version TEXT;

DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['ai_evaluations', 'document_runs', 'manual_application_document_runs'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass(target) AND conname = target || '_prompt_pair_chk'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (
           (prompt_id IS NULL AND prompt_version IS NULL)
           OR (
             prompt_id IS NOT NULL AND prompt_version IS NOT NULL
             AND BTRIM(prompt_id) <> '''' AND BTRIM(prompt_version) <> ''''
             AND char_length(prompt_id) <= 200 AND char_length(prompt_version) <= 100
           )
         )',
        target, target || '_prompt_pair_chk'
      );
    END IF;
  END LOOP;
END
$$;
