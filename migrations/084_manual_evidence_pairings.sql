-- Migration 084: stored requirement-to-evidence pairings for the manual application route.
-- A model proposes the pairs once per (job version, requirement set, profile version); compare,
-- approve and generate all read the same stored row, so the approved comparison can be rebuilt
-- exactly. Failed attempts are recorded with their error, and the route falls back to strict word
-- matching for that comparison.
--
-- Safe rollback (only removes stored pairings; drafts and approvals keep their persisted comparisons):
-- BEGIN;
-- DROP TABLE IF EXISTS manual_evidence_pairings;
-- COMMIT;

CREATE TABLE IF NOT EXISTS manual_evidence_pairings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  job_version_id UUID NOT NULL,
  requirement_set_id UUID NOT NULL,
  profile_version_id UUID NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'FAILED')),
  provider TEXT,
  model TEXT,
  pairs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(pairs) = 'array'),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT manual_evidence_pairings_completed_has_no_error CHECK (status = 'FAILED' OR error_message IS NULL),
  CONSTRAINT manual_evidence_pairings_failed_has_error CHECK (status = 'COMPLETED' OR error_message IS NOT NULL),
  CONSTRAINT manual_evidence_pairings_scope UNIQUE (workspace_id, job_version_id, requirement_set_id, profile_version_id, method)
);

CREATE INDEX IF NOT EXISTS idx_manual_evidence_pairings_lookup
  ON manual_evidence_pairings (workspace_id, job_version_id, requirement_set_id, profile_version_id);
