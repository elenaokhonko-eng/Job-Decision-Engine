-- Migration 041: persist current matching artifact provenance
--
-- Historical match runs remain immutable. These additive columns allow workers
-- and read models to distinguish a current artifact from a successful artifact
-- produced for an older requirement set, job content, or context.

ALTER TABLE match_runs
  ADD COLUMN IF NOT EXISTS requirement_set_id UUID REFERENCES requirement_sets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS job_content_hash TEXT,
  ADD COLUMN IF NOT EXISTS context_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_match_runs_current_context
  ON match_runs(workspace_id, job_version_id, profile_version_id, requirement_set_id, context_fingerprint, status);

ALTER TABLE deterministic_decisions
  ADD COLUMN IF NOT EXISTS context_fingerprint TEXT;

-- A policy snapshot alone is not a sufficient decision identity: a new active
-- profile or match run can produce a different decision under the same policy.
-- Preserve all historical rows and make the full current context the identity.
ALTER TABLE deterministic_decisions
  DROP CONSTRAINT IF EXISTS deterministic_decisions_workspace_canonical_job_id_job_version_id_policy_snapshot_id_key;

ALTER TABLE deterministic_decisions
  ADD CONSTRAINT deterministic_decisions_workspace_job_version_policy_context_key
  UNIQUE (workspace_id, canonical_job_id, job_version_id, policy_snapshot_id, context_fingerprint);

CREATE INDEX IF NOT EXISTS idx_deterministic_decisions_context
  ON deterministic_decisions(workspace_id, job_version_id, context_fingerprint, created_at DESC);

COMMENT ON COLUMN match_runs.requirement_set_id IS
  'Requirement set used by this immutable match run; NULL denotes a legacy run whose currentness cannot be proven.';
COMMENT ON COLUMN match_runs.job_content_hash IS
  'Job-version content hash used by this immutable match run.';
COMMENT ON COLUMN match_runs.context_fingerprint IS
  'Deterministic pipeline context fingerprint for the match artifact.';
COMMENT ON COLUMN deterministic_decisions.context_fingerprint IS
  'Deterministic pipeline context fingerprint for the decision artifact.';
