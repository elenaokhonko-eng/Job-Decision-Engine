-- Migration 083: profile-level document preferences.
-- document_layout: how a role appears on application CVs unless the candidate chooses otherwise for one job
--   (FULL entry, ONE_LINE, or HIDDEN); NULL keeps the automatic choice.
-- always_include_in_documents: list this credential under Certifications regardless of relevance ranking.
-- Both are additive and nullable/defaulted, so existing profile versions keep their behaviour.
--
-- Safe rollback (drops only these two preference columns; no profile evidence is removed):
-- BEGIN;
-- ALTER TABLE profile_engagements DROP COLUMN IF EXISTS document_layout;
-- ALTER TABLE profile_credentials DROP COLUMN IF EXISTS always_include_in_documents;
-- COMMIT;

ALTER TABLE profile_engagements ADD COLUMN IF NOT EXISTS document_layout TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profile_engagements_document_layout_check'
      AND conrelid = 'profile_engagements'::regclass
  ) THEN
    ALTER TABLE profile_engagements ADD CONSTRAINT profile_engagements_document_layout_check
      CHECK (document_layout IS NULL OR document_layout IN ('FULL', 'ONE_LINE', 'HIDDEN'));
  END IF;
END $$;

ALTER TABLE profile_credentials ADD COLUMN IF NOT EXISTS always_include_in_documents BOOLEAN NOT NULL DEFAULT FALSE;
