-- Additive: one new table and one new view. No existing table, column or view changes.
--
-- Reversal. First revert the code that reads or writes these objects (the decider, the worker, the zero check, the
-- API and Streamlit lists), then run these three statements in this order. Without the third, the migration runner
-- takes 124 as applied and never creates the objects again.
--   DROP VIEW IF EXISTS v_job_awaiting_rematch;
--   DROP TABLE IF EXISTS job_rematch_waits;
--   DELETE FROM schema_migrations WHERE version = '124_awaiting_rematch_view.sql';
--
-- A job "awaits a re-match" for one of the decider's three reasons: it keeps its stored result until then. Only the
-- lists that read this view mark it.
--   1. It holds a stored score and its profile match is not current (the current-match test is the decider's). Jobs
--      already settled (ineligible, or no matching lane) are not waiting for this reason.
--   2. It was restored from the archive, holds a result (with or without a score), and no match has completed since
--      the restore, even where the match from before the archive still looks current. This is the condition of
--      restoredAwaitingRematchSql (src/pipeline/profileMatchCurrency.ts).
--   3. A re-gate lifted it out of rejection (the gate decision before was HARD_REJECT, per gate_decisions), it holds a
--      result, and no match has completed since. This is the condition of liftedAwaitingRematchSql (same file).
--
-- job_rematch_waits (owner: the decision module) records WHEN a job started waiting, and nothing else. A row is
-- inserted the first time the job is found waiting, is never moved by a later pass, and is deleted when the job no
-- longer waits. It is never derived from the age of the last match: a system that was paused does not start with old
-- waits.
CREATE TABLE IF NOT EXISTS job_rematch_waits (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  canonical_job_id UUID NOT NULL,
  waiting_since TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, canonical_job_id),
  -- The job belongs to that workspace: a row naming another workspace's job is rejected.
  FOREIGN KEY (workspace_id, canonical_job_id) REFERENCES canonical_jobs (workspace_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE job_rematch_waits IS
  'When each currently waiting job started to wait for a re-match. Written only by the decision module.';

-- Which jobs wait now, and since when. waiting_since is NULL until the first pass or decider run has recorded the job.
CREATE OR REPLACE VIEW v_job_awaiting_rematch AS
SELECT
  job.workspace_id,
  job.id AS canonical_job_id,
  job.latest_job_version_id AS job_version_id,
  recorded.waiting_since
FROM canonical_jobs job
LEFT JOIN job_versions version
  ON version.workspace_id = job.workspace_id
 AND version.id = job.latest_job_version_id
LEFT JOIN match_runs run
  ON run.workspace_id = job.workspace_id
 AND run.id = job.latest_match_run_id
LEFT JOIN LATERAL (
  SELECT profile_version.id
  FROM profile_versions profile_version
  WHERE profile_version.workspace_id = job.workspace_id
    AND profile_version.status = 'ACTIVE'
  ORDER BY profile_version.created_at DESC
  LIMIT 1
) active_profile ON TRUE
LEFT JOIN job_rematch_waits recorded
  ON recorded.workspace_id = job.workspace_id
 AND recorded.canonical_job_id = job.id
WHERE job.archived_at IS NULL
  AND job.is_test_fixture IS NOT TRUE
  AND COALESCE(job.processing_state, job.processing_status) IS DISTINCT FROM 'MANUALLY_REMOVED'
  AND (
    (
      (job.recommendation_requirement_score IS NOT NULL OR job.recommendation_coverage_score IS NOT NULL)
      AND job.recommendation_eligibility IS DISTINCT FROM 'INELIGIBLE'
      AND job.routing_disposition IS DISTINCT FROM 'POLICY_NO_MATCH'
      AND NOT COALESCE(
        run.status = 'COMPLETED'
        AND run.canonical_job_id = job.id
        AND run.job_version_id = job.latest_job_version_id
        AND run.profile_version_id = active_profile.id
        AND run.requirement_set_id = version.active_requirement_set_id
        AND run.job_content_hash = version.content_hash
        AND run.context_fingerprint IS NOT NULL,
        FALSE)
    )
    OR (
      (job.recommendation_outcome IS NOT NULL OR job.recommendation_eligibility IS NOT NULL
        OR job.recommendation_requirement_score IS NOT NULL)
      AND EXISTS (
        SELECT 1 FROM job_archive_events restore_event
         WHERE restore_event.workspace_id = job.workspace_id AND restore_event.canonical_job_id = job.id
           AND restore_event.action IN ('RESTORED', 'REPOST_REACTIVATED')
           AND restore_event.details->>'rematch_required' = 'true'
           AND NOT EXISTS (
             SELECT 1 FROM match_runs rematch
              WHERE rematch.workspace_id = job.workspace_id AND rematch.canonical_job_id = job.id
                AND rematch.status = 'COMPLETED' AND rematch.started_at > restore_event.event_at))
    )
    OR (
      -- A re-gate lifted the job out of rejection (gate_decisions) and no match has completed since.
      (job.recommendation_outcome IS NOT NULL OR job.recommendation_eligibility IS NOT NULL
        OR job.recommendation_requirement_score IS NOT NULL)
      AND job.gate_decision IS DISTINCT FROM 'HARD_REJECT'
      AND COALESCE(job.processing_state, job.processing_status) IS DISTINCT FROM 'HARD_REJECTED'
      AND NOT COALESCE(COALESCE(job.processing_state, job.processing_status) = 'UNMATCHED'
                       AND job.routing_disposition = 'POLICY_NO_MATCH', FALSE)
      AND EXISTS (
        SELECT 1 FROM gate_decisions lifted
         WHERE lifted.workspace_id = job.workspace_id AND lifted.canonical_job_id = job.id AND lifted.decision <> 'HARD_REJECT'
           AND (SELECT earlier.decision FROM gate_decisions earlier
                 WHERE earlier.workspace_id = lifted.workspace_id AND earlier.canonical_job_id = lifted.canonical_job_id
                   AND (earlier.created_at, earlier.id) < (lifted.created_at, lifted.id)
                 ORDER BY earlier.created_at DESC, earlier.id DESC LIMIT 1) = 'HARD_REJECT'
           AND NOT EXISTS (
             SELECT 1 FROM gate_decisions again
              WHERE again.workspace_id = lifted.workspace_id AND again.canonical_job_id = lifted.canonical_job_id
                AND again.decision = 'HARD_REJECT' AND (again.created_at, again.id) > (lifted.created_at, lifted.id))
           AND NOT EXISTS (
             SELECT 1 FROM match_runs rematch
              WHERE rematch.workspace_id = lifted.workspace_id AND rematch.canonical_job_id = lifted.canonical_job_id
                AND rematch.status = 'COMPLETED' AND rematch.started_at > lifted.created_at))
    )
  );

COMMENT ON VIEW v_job_awaiting_rematch IS
  'Live jobs keeping a stored result until a re-match (no current profile match, restored, or lifted out of rejection, and not re-matched), and since when. Read by the lists and by the zero check awaiting_rematch_over_limit.';
