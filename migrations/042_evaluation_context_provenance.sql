-- Migration 042: bind AI queue/evaluation rows to current deterministic context
--
-- Existing evaluations are historical evidence. New evaluation work must carry
-- the active profile, match, decision, job content, and context identity that
-- produced it; otherwise a stale evaluation can look current after a profile
-- change.

ALTER TABLE evaluation_queue
  ADD COLUMN IF NOT EXISTS profile_version_id UUID REFERENCES profile_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS match_run_id UUID REFERENCES match_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deterministic_decision_id UUID REFERENCES deterministic_decisions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS job_content_hash TEXT,
  ADD COLUMN IF NOT EXISTS context_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_evaluation_queue_current_context
  ON evaluation_queue(workspace_id, job_version_id, profile_version_id, match_run_id, deterministic_decision_id, status);

ALTER TABLE ai_evaluations
  ADD COLUMN IF NOT EXISTS profile_version_id UUID REFERENCES profile_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS match_run_id UUID REFERENCES match_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deterministic_decision_id UUID REFERENCES deterministic_decisions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS job_content_hash TEXT,
  ADD COLUMN IF NOT EXISTS context_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_evaluations_current_context
  ON ai_evaluations(workspace_id, job_version_id, profile_version_id, match_run_id, deterministic_decision_id, evaluated_at DESC);

COMMENT ON COLUMN evaluation_queue.context_fingerprint IS
  'Current deterministic context identity required before AI evaluation may start.';
COMMENT ON COLUMN ai_evaluations.context_fingerprint IS
  'Immutable context identity used to produce this AI evaluation.';
