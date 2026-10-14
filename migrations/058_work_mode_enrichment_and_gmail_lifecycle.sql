-- Migration 058: Work-mode enrichment provenance and Gmail alert lifecycle tracking
--
-- Goals:
-- 1. Idempotent storage for automatic work-mode evidence enrichment before rejection.
-- 2. Lineage tracking from Gmail message ID to raw observations and canonical jobs.
-- 3. Gmail lifecycle tracking (In-Processing, Terminal Cleaned, Trashed, Marked Read).

-- 1. Work-mode enrichment history table
CREATE TABLE IF NOT EXISTS work_mode_enrichments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
  job_version_id UUID REFERENCES job_versions(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  source_url TEXT,
  source_type TEXT NOT NULL, -- 'STRUCTURED_METADATA', 'CANONICAL_PAGE', 'STORED_DESCRIPTION'
  status TEXT NOT NULL, -- 'ENRICHED', 'FAILED', 'SKIPPED', 'GENUINELY_UNKNOWN'
  workplace_type TEXT NOT NULL DEFAULT 'UNKNOWN',
  office_days_min INT,
  office_days_max INT,
  attendance_basis TEXT,
  territory_restriction TEXT,
  work_auth_restriction TEXT,
  evidence_quote TEXT,
  extractor_version TEXT NOT NULL DEFAULT 'work_mode_enrichment_v1',
  raw_payload JSONB,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_work_mode_enrichments_job
  ON work_mode_enrichments (workspace_id, canonical_job_id, job_version_id);

-- 2. Gmail lifecycle columns on raw_email_alerts
ALTER TABLE raw_email_alerts
  ADD COLUMN IF NOT EXISTS in_processing_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS marked_read_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT DEFAULT 'PENDING';

-- 3. Lineage columns on raw_job_observations
ALTER TABLE raw_job_observations
  ADD COLUMN IF NOT EXISTS raw_email_alert_id UUID REFERENCES raw_email_alerts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gmail_message_id TEXT;

CREATE INDEX IF NOT EXISTS idx_raw_job_observations_gmail_msg
  ON raw_job_observations (workspace_id, gmail_message_id);

CREATE INDEX IF NOT EXISTS idx_raw_job_observations_email_alert
  ON raw_job_observations (workspace_id, raw_email_alert_id);

-- 4. Backfill raw_job_observations lineage from existing raw_email_alerts
-- Matching by gmail_message_id pattern: source_external_id = 'gmail-' || rea.gmail_message_id || '-%'
UPDATE raw_job_observations obs
SET raw_email_alert_id = rea.id,
    gmail_message_id = rea.gmail_message_id
FROM raw_email_alerts rea
WHERE obs.workspace_id = rea.workspace_id
  AND obs.raw_email_alert_id IS NULL
  AND rea.gmail_message_id IS NOT NULL
  AND (
    obs.source_external_id LIKE 'gmail-' || rea.gmail_message_id || '-%'
    OR obs.source_external_id = 'gmail-' || rea.gmail_message_id
  );

COMMENT ON TABLE work_mode_enrichments IS
  'Idempotent provenance ledger for automatic work-mode evidence enrichment before rejection.';
COMMENT ON COLUMN raw_email_alerts.lifecycle_status IS
  'Gmail alert lifecycle: PENDING (staged), IN_PROCESSING (underway), TERMINAL_CLEANED (trashed), RETAINED_NONTERMINAL.';
