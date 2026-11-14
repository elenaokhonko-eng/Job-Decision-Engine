-- Migration 111: allow the hard-rejected archive rule's basis.
--
-- Archiving now has two independent rules (src/services/jobArchive.ts):
--   1. JOB_OLDER_THAN_THREE_CALENDAR_MONTHS (unchanged), whose basis is the evidenced age:
--      GENUINE_REPOST_DATE, AUTHORITATIVE_PUBLICATION_DATE or OBSERVED_AGE_PUBLICATION_UNKNOWN.
--   2. HARD_REJECTED_PERMANENT (new): a job with processing_state HARD_REJECTED and gate_decision
--      HARD_REJECT, stored rejection codes, no LINKEDIN_SAVED/MCF_SAVED observation and no archive
--      protection. Its basis is HARD_REJECTED_DECISION and archive_reference_at is the created_at of
--      the job's latest gate_decisions row (canonical_jobs.updated_at only when the job has no gate
--      decision row; the archive event details record which source was used).
--
-- This migration only widens the two CHECK constraints that list the allowed bases
-- (canonical_jobs_archive_metadata_check and job_archive_events_age_basis_check). No row is
-- updated, moved or deleted, and every existing row satisfies the widened constraint.
--
-- Rollback: stop the new rule first (run scripts/archive_jobs.ts with --rule age, or set the
-- JOB_ARCHIVING_RULE repository variable to age). The widened constraints can stay in place: they
-- accept everything the old ones did. Re-narrowing them requires that no canonical job or archive
-- event uses HARD_REJECTED_DECISION, which means restoring every HARD_REJECTED_PERMANENT archive
-- through restoreArchivedJob (audited) first. Archive events are append-only and must never be
-- deleted, so the event constraint can only be re-narrowed with explicit human approval and a
-- NOT VALID constraint that leaves historical events in place.

ALTER TABLE canonical_jobs
  DROP CONSTRAINT IF EXISTS canonical_jobs_archive_metadata_check;

ALTER TABLE canonical_jobs
  ADD CONSTRAINT canonical_jobs_archive_metadata_check CHECK (
    (archived_at IS NULL
      AND archive_reason IS NULL
      AND archive_age_basis IS NULL
      AND archive_reference_at IS NULL)
    OR
    (archived_at IS NOT NULL
      AND NULLIF(BTRIM(archive_reason), '') IS NOT NULL
      AND archive_age_basis IS NOT NULL
      AND archive_age_basis IN (
        'GENUINE_REPOST_DATE',
        'AUTHORITATIVE_PUBLICATION_DATE',
        'OBSERVED_AGE_PUBLICATION_UNKNOWN',
        'HARD_REJECTED_DECISION'
      )
      AND archive_reference_at IS NOT NULL)
  ) NOT VALID;

ALTER TABLE canonical_jobs
  VALIDATE CONSTRAINT canonical_jobs_archive_metadata_check;

ALTER TABLE job_archive_events
  DROP CONSTRAINT IF EXISTS job_archive_events_age_basis_check;

ALTER TABLE job_archive_events
  ADD CONSTRAINT job_archive_events_age_basis_check CHECK (
    age_basis IS NULL OR age_basis IN (
      'GENUINE_REPOST_DATE',
      'AUTHORITATIVE_PUBLICATION_DATE',
      'OBSERVED_AGE_PUBLICATION_UNKNOWN',
      'HARD_REJECTED_DECISION'
    )
  ) NOT VALID;

ALTER TABLE job_archive_events
  VALIDATE CONSTRAINT job_archive_events_age_basis_check;

-- Supports the hard-rejected rule's candidate scan.
CREATE INDEX IF NOT EXISTS idx_canonical_jobs_hard_rejected_unarchived
  ON canonical_jobs (workspace_id, id)
  WHERE archived_at IS NULL AND processing_state = 'HARD_REJECTED';

COMMENT ON COLUMN canonical_jobs.archive_age_basis IS
  'GENUINE_REPOST_DATE, AUTHORITATIVE_PUBLICATION_DATE or OBSERVED_AGE_PUBLICATION_UNKNOWN for the three-calendar-month age rule (the last means observed age; publication date unknown); HARD_REJECTED_DECISION for the HARD_REJECTED_PERMANENT rule, whose reference is the latest hard-gate decision time.';
