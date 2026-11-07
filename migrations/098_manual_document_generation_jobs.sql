-- Migration 098: durable manual document generation jobs.
--
-- POST /api/v2/application-drafts/:draftId/documents now starts a generation job and returns at
-- once; the CV summary, cover letter and files are produced in the API process and the client polls
-- GET /api/v2/application-drafts/:draftId/document-jobs/:jobId. One approval has at most one
-- QUEUED, RUNNING or SUCCEEDED job (partial unique index), so a repeated POST returns the existing
-- job instead of generating twice. FAILED jobs stay as history and a new job may be started.
-- A RUNNING job whose deadline passed (for example after an API restart) is marked FAILED with
-- error_code GENERATION_INTERRUPTED by the API on its next read; nothing else depends on it.
-- The job never records an application or a submission; documents are stored exactly as before
-- in manual_application_document_runs / _claims / _artifacts. Prompt text is never stored.
-- Rollback: deploy the previous API and Streamlit build; the table can stay (it is history only),
-- or be dropped with DROP TABLE manual_document_generation_jobs once no build reads it.

CREATE TABLE IF NOT EXISTS manual_document_generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  draft_id UUID NOT NULL,
  approval_id UUID NOT NULL,
  comparison_fingerprint TEXT NOT NULL CHECK (comparison_fingerprint ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  -- [{step: SUMMARY|LETTER|FILES, status, started_at, finished_at, elapsed_ms, model, provider,
  --   outcome, failure_kind}] -- no prompt or document text.
  steps JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array'),
  -- The non-secret generation options of the first request (role layout, gap note choices).
  request_options JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(request_options) = 'object'),
  -- The documents response (previews, artifact list, reviews) once SUCCEEDED.
  result JSONB CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  error_code TEXT CHECK (error_code IS NULL OR LENGTH(error_code) <= 64),
  error_message TEXT CHECK (error_message IS NULL OR LENGTH(error_message) <= 2000),
  error_http_status INTEGER CHECK (error_http_status IS NULL OR error_http_status BETWEEN 400 AND 599),
  deadline_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT manual_document_generation_jobs_approval_fk
    FOREIGN KEY (approval_id, workspace_id, user_id)
    REFERENCES manual_application_preparation_approvals (id, workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((status = 'SUCCEEDED') = (result IS NOT NULL)),
  CHECK ((status = 'FAILED') = (error_code IS NOT NULL)),
  CHECK ((status IN ('SUCCEEDED', 'FAILED')) = (finished_at IS NOT NULL))
);

-- At most one live or completed job per approval: a second POST gets the existing job.
CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_document_generation_jobs_live_approval
  ON manual_document_generation_jobs (workspace_id, user_id, approval_id)
  WHERE status IN ('QUEUED', 'RUNNING', 'SUCCEEDED');

CREATE INDEX IF NOT EXISTS idx_manual_document_generation_jobs_draft
  ON manual_document_generation_jobs (workspace_id, user_id, draft_id, created_at DESC);
