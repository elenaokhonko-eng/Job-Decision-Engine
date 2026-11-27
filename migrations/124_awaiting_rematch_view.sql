-- Additive: one new read-only view. No table, column or existing view changes.
-- Reversal: DROP VIEW IF EXISTS v_job_awaiting_rematch;
--
-- A job "awaits a re-match" when it holds a stored score and its profile match is not current: it keeps that score
-- and outcome, and every list marks it. The current-match test is the decider's. Jobs already settled without a score
-- (ineligible, or no matching lane) are not waiting.
--
-- waiting_since is the earliest thing that happened after the last decision computed from a current score and could
-- have made the match stale: a new profile, job version or requirement set, a match that did not complete, or a gate
-- decision that removed the match pointer. It does not move while the job keeps waiting.
CREATE OR REPLACE VIEW v_job_awaiting_rematch AS
WITH waiting AS (
  SELECT
    job.workspace_id,
    job.id AS canonical_job_id,
    job.latest_job_version_id AS job_version_id,
    job.latest_match_run_id,
    job.created_at
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
  WHERE job.archived_at IS NULL
    AND job.is_test_fixture IS NOT TRUE
    AND COALESCE(job.processing_state, job.processing_status) IS DISTINCT FROM 'MANUALLY_REMOVED'
    AND (job.recommendation_requirement_score IS NOT NULL OR job.recommendation_coverage_score IS NOT NULL)
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
SELECT
  waiting.workspace_id,
  waiting.canonical_job_id,
  waiting.job_version_id,
  COALESCE(
    LEAST(
      (SELECT MIN(profile_version.created_at) FROM profile_versions profile_version
        WHERE profile_version.workspace_id = waiting.workspace_id AND profile_version.created_at > anchor.at),
      (SELECT MIN(version.observed_at) FROM job_versions version
        WHERE version.workspace_id = waiting.workspace_id AND version.canonical_job_id = waiting.canonical_job_id
          AND version.observed_at > anchor.at),
      (SELECT MIN(requirement_set.created_at) FROM requirement_sets requirement_set
        WHERE requirement_set.workspace_id = waiting.workspace_id AND requirement_set.canonical_job_id = waiting.canonical_job_id
          AND requirement_set.created_at > anchor.at),
      (SELECT MIN(match_run.started_at) FROM match_runs match_run
        WHERE match_run.workspace_id = waiting.workspace_id AND match_run.canonical_job_id = waiting.canonical_job_id
          AND match_run.status <> 'COMPLETED' AND match_run.started_at > anchor.at),
      (SELECT MIN(gate.created_at) FROM gate_decisions gate
        WHERE gate.workspace_id = waiting.workspace_id AND gate.canonical_job_id = waiting.canonical_job_id
          AND waiting.latest_match_run_id IS NULL AND gate.created_at > anchor.at)
    ),
    anchor.at
  ) AS waiting_since
FROM waiting
CROSS JOIN LATERAL (
  SELECT COALESCE(
    (SELECT MAX(decision.created_at) FROM deterministic_decisions decision
      WHERE decision.workspace_id = waiting.workspace_id AND decision.canonical_job_id = waiting.canonical_job_id
        AND decision.decision_json->'inputs'->>'requirement_score' IS NOT NULL),
    -- No decision from a current score on record: count from the job itself, which no later run can move.
    waiting.created_at
  ) AS at
) anchor;

COMMENT ON VIEW v_job_awaiting_rematch IS
  'Live jobs holding a stored score with no current profile match, and since when. Read by the lists and by the zero check awaiting_rematch_over_limit.';
