-- Migration 085: the candidate's corrections to a manual comparison, recorded with the approval.
-- corrections: per requirement, what the candidate decided before approving (accept or change the
--   evidence, mark NOT_APPLICABLE, GAP or PARTIAL with an optional gap sentence). Documents are built
--   from the comparison with these corrections applied.
-- corrections_fingerprint: sha256 of the normalised corrections ('' when there are none), so an
--   approval identifies exactly what was reviewed.
-- revision: a later approval of the same comparison and corrections (for example to retry an AI
--   section that fell back); each revision generates its own documents and keeps earlier ones.
-- Existing approvals get no corrections and revision 1, so their identity and documents are unchanged.
--
-- Safe rollback (removes only the review columns; first keep one revision per draft and comparison,
-- since the narrower unique key cannot hold several):
-- BEGIN;
-- ALTER TABLE manual_application_preparation_approvals DROP CONSTRAINT IF EXISTS manual_application_approvals_exact_revision_key;
-- ALTER TABLE manual_application_preparation_approvals
--   ADD CONSTRAINT manual_application_approvals_exact_once_key UNIQUE (workspace_id, user_id, draft_id, comparison_fingerprint);
-- ALTER TABLE manual_application_preparation_approvals DROP COLUMN IF EXISTS corrections,
--   DROP COLUMN IF EXISTS corrections_fingerprint, DROP COLUMN IF EXISTS revision;
-- COMMIT;

ALTER TABLE manual_application_preparation_approvals
  ADD COLUMN IF NOT EXISTS corrections JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS corrections_fingerprint TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'manual_application_approvals_corrections_check'
      AND conrelid = 'manual_application_preparation_approvals'::regclass
  ) THEN
    ALTER TABLE manual_application_preparation_approvals ADD CONSTRAINT manual_application_approvals_corrections_check
      CHECK (jsonb_typeof(corrections) = 'array'
        AND (corrections_fingerprint = '' OR corrections_fingerprint ~ '^[a-f0-9]{64}$')
        AND (corrections_fingerprint = '') = (jsonb_array_length(corrections) = 0)
        AND revision >= 1);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'manual_application_approvals_exact_revision_key'
      AND conrelid = 'manual_application_preparation_approvals'::regclass
  ) THEN
    ALTER TABLE manual_application_preparation_approvals ADD CONSTRAINT manual_application_approvals_exact_revision_key
      UNIQUE (workspace_id, user_id, draft_id, comparison_fingerprint, corrections_fingerprint, revision);
    ALTER TABLE manual_application_preparation_approvals DROP CONSTRAINT IF EXISTS manual_application_approvals_exact_once_key;
  END IF;
END $$;
