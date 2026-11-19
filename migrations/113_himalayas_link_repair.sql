-- Migration 113: Himalayas link repair log and the "posting not confirmable" archive basis.
--
-- Himalayas jobs ingested before the adapter read the live feed fields (PR #198) hold an invented
-- posting link (himalayas.app/jobs/<hash>) or the API address, and often location "Unknown".
-- scripts/repair_himalayas_links.ts repairs what the stored payload can prove and archives the rest
-- with its own reason, POSTING_NOT_CONFIRMABLE: nobody knows the posting is closed, its real link was
-- never stored, so it is not marked closed. The archive is reversible through restoreArchivedJob.
--
-- Additive only. Widens the two archive-basis CHECK constraints by one value (every existing row
-- still satisfies them) and creates an append-only repair log holding the old values.
--
-- Rollback: restore archived jobs through restoreArchivedJob (audited), then the old canonical_url and
-- location of every repaired job can be read back from himalayas_link_repair_log. The widened
-- constraints can stay in place.

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
        'HARD_REJECTED_DECISION',
        'POSTING_LINK_UNVERIFIABLE'
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
      'HARD_REJECTED_DECISION',
      'POSTING_LINK_UNVERIFIABLE'
    )
  ) NOT VALID;

ALTER TABLE job_archive_events
  VALIDATE CONSTRAINT job_archive_events_age_basis_check;

CREATE TABLE IF NOT EXISTS himalayas_link_repair_log (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE RESTRICT,
  repair_run_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('LINK_REPAIRED', 'LOCATION_REPAIRED', 'LINK_AND_LOCATION_REPAIRED', 'ARCHIVED_NOT_CONFIRMABLE', 'KEPT_FOR_RESCUE')),
  old_canonical_url TEXT,
  new_canonical_url TEXT,
  old_location TEXT,
  new_location TEXT,
  restore_point TEXT NOT NULL CHECK (NULLIF(BTRIM(restore_point), '') IS NOT NULL),
  repaired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_himalayas_link_repair_log_job
  ON himalayas_link_repair_log (workspace_id, canonical_job_id, repaired_at DESC);

COMMENT ON TABLE himalayas_link_repair_log IS
  'Append-only: old and new canonical_url / location for each Himalayas job touched by scripts/repair_himalayas_links.ts, plus the Neon restore point taken first.';
