-- Migration 038: Application tracker and submission handoff
--
-- Goals:
-- 1) Track human-owned application lifecycle without auto-submitting anything.
-- 2) Link the selected job version to generated CV / cover-letter document runs.
-- 3) Preserve an append-only event log for status transitions and follow-up notes.
--
-- Notes:
-- - Additive and reversible.
-- - No existing job, document, or queue state is mutated.

CREATE TABLE IF NOT EXISTS application_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES workspace_users(id) ON DELETE CASCADE,
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
  job_version_id UUID NOT NULL REFERENCES job_versions(id) ON DELETE CASCADE,

  status TEXT NOT NULL CHECK (status IN (
    'INTENT',
    'READY_TO_APPLY',
    'SUBMITTED',
    'FOLLOW_UP',
    'INTERVIEW',
    'OFFER',
    'REJECTED',
    'WITHDRAWN',
    'CLOSED'
  )),
  submission_url TEXT,
  cv_document_run_id UUID REFERENCES document_runs(id) ON DELETE SET NULL,
  cover_letter_document_run_id UUID REFERENCES document_runs(id) ON DELETE SET NULL,
  notes TEXT,
  handoff_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  target_submit_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  follow_up_at TIMESTAMPTZ,
  last_action_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (workspace_id, user_id, canonical_job_id, job_version_id)
);

CREATE INDEX IF NOT EXISTS idx_application_records_workspace_status
  ON application_records(workspace_id, user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_application_records_job_version
  ON application_records(workspace_id, job_version_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS application_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  application_record_id UUID NOT NULL REFERENCES application_records(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'CREATED',
    'STATUS_CHANGED',
    'DOCUMENT_LINKED',
    'NOTE_ADDED',
    'SUBMISSION_HANDOFF',
    'FOLLOW_UP_SCHEDULED'
  )),
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_application_events_record
  ON application_events(workspace_id, application_record_id, created_at DESC);

CREATE OR REPLACE VIEW v_application_tracker AS
SELECT
  ar.id AS application_record_id,
  ar.workspace_id,
  ar.user_id,
  ar.canonical_job_id,
  ar.job_version_id,
  c.normalized_title AS title,
  c.company_name AS company,
  c.canonical_url,
  c.processing_state,
  c.processing_status,
  c.recommendation_eligibility,
  c.recommendation_outcome,
  c.primary_lane,
  c.secondary_lanes,
  ar.status AS application_status,
  ar.submission_url,
  ar.cv_document_run_id,
  ar.cover_letter_document_run_id,
  ar.notes,
  ar.handoff_payload,
  ar.target_submit_at,
  ar.submitted_at,
  ar.follow_up_at,
  ar.last_action_at,
  ar.created_at,
  ar.updated_at
FROM application_records ar
JOIN canonical_jobs c
  ON c.workspace_id = ar.workspace_id
 AND c.id = ar.canonical_job_id;

COMMENT ON TABLE application_records IS
  'Human-owned application tracker records. These rows prepare and record handoff/submission state; they do not authorize automated submission.';

COMMENT ON TABLE application_events IS
  'Append-only application tracker event log for status changes, document links, and human notes.';
