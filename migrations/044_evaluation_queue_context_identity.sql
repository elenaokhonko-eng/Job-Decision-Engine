-- Migration 044: allow current evaluation work to coexist with stale queue history
--
-- Migration 006 enforced one active evaluation row per canonical job. That
-- identity is too coarse after profile, match, decision, or job-version
-- changes: an old pending row can prevent the current context from entering
-- the queue. Preserve those rows as audit history and make new active work
-- unique by its complete current context instead.

UPDATE evaluation_queue
SET status = 'NEEDS_MANUAL_REVIEW',
    available_at = NULL,
    lease_id = NULL,
    lease_expires_at = NULL,
    last_error = COALESCE(
      last_error,
      'Legacy evaluation queue row has no current profile/match/decision context; quarantined for reconciliation.'
    ),
    updated_at = NOW()
WHERE status IN ('PENDING', 'EVALUATING', 'RETRY_WAIT')
  AND (
    profile_version_id IS NULL
    OR match_run_id IS NULL
    OR deterministic_decision_id IS NULL
    OR job_content_hash IS NULL
    OR context_fingerprint IS NULL
  );

-- A non-null context can still be stale if it belongs to an older active
-- profile, match run, decision, or job version. Quarantine those active rows
-- as well so the evaluator cannot repeatedly inspect work that can no longer
-- produce a current artifact.
UPDATE evaluation_queue eq
SET status = 'NEEDS_MANUAL_REVIEW',
    available_at = NULL,
    lease_id = NULL,
    lease_expires_at = NULL,
    last_error = COALESCE(
      last_error,
      'Evaluation queue context is stale relative to the active profile/match/decision; quarantined for reconciliation.'
    ),
    updated_at = NOW()
WHERE eq.status IN ('PENDING', 'EVALUATING', 'RETRY_WAIT')
  AND NOT EXISTS (
    SELECT 1
    FROM canonical_jobs c
    JOIN job_versions jv
      ON jv.workspace_id = c.workspace_id
     AND jv.id = c.latest_job_version_id
    JOIN profile_versions pv
      ON pv.workspace_id = c.workspace_id
     AND pv.status = 'ACTIVE'
    JOIN match_runs mr
      ON mr.workspace_id = c.workspace_id
     AND mr.id = c.latest_match_run_id
     AND mr.job_version_id = jv.id
     AND mr.profile_version_id = pv.id
     AND mr.requirement_set_id = jv.active_requirement_set_id
     AND mr.job_content_hash = jv.content_hash
     AND mr.context_fingerprint IS NOT NULL
     AND mr.status = 'COMPLETED'
    JOIN deterministic_decisions dd
      ON dd.workspace_id = c.workspace_id
     AND dd.id = c.latest_deterministic_decision_id
     AND dd.job_version_id = jv.id
     AND dd.match_run_id = mr.id
     AND dd.context_fingerprint IS NOT NULL
    WHERE c.workspace_id = eq.workspace_id
      AND c.id = eq.canonical_job_id
      AND eq.job_version_id = jv.id
      AND eq.profile_version_id = pv.id
      AND eq.match_run_id = mr.id
      AND eq.deterministic_decision_id = dd.id
      AND eq.job_content_hash = jv.content_hash
      AND eq.context_fingerprint = dd.context_fingerprint
  );

DROP INDEX IF EXISTS idx_evaluation_queue_active_job;

-- New queue rows are required to carry a non-null context fingerprint. The
-- partial predicate leaves any already-quarantined legacy null rows intact
-- without letting them block current work.
CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluation_queue_active_context
  ON evaluation_queue (
    workspace_id,
    canonical_job_id,
    job_version_id,
    context_fingerprint
  )
  WHERE status IN ('PENDING', 'EVALUATING', 'RETRY_WAIT')
    AND context_fingerprint IS NOT NULL;

COMMENT ON INDEX idx_evaluation_queue_active_context IS
  'At most one active evaluation queue row per workspace/job-version/context; stale contexts remain auditable.';
