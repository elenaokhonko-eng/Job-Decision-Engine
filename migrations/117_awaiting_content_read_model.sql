-- Migration 117: "awaiting content". A job whose posting text has not reached the completeness rule has no
-- gate result, lane or recommendation in any list; it waits until the posting is fetched.
--
-- Root cause: the hard gate (src/pipeline/hardGate.ts), lane router and matcher already require
-- description_quality_status = 'COMPLETE' and retrieved-posting evidence for a new job, but outputs produced
-- before the rule, or by a description that later changed, stayed on the job and kept appearing in the
-- Streamlit lists (about 519 live jobs known only from an alert snippet).
--
-- 1. v_job_content_state: one row per canonical job saying whether its current version has complete content.
--    The rule is the SQL statement of sourceContentEvidencePredicate() and description_quality_status in
--    src/pipeline/descriptionQuality.ts; src/tests/ingestion/awaitingContent.integration.test.ts fails if
--    the two differ. A version with no observation at all is a different defect (invariant 2), not a content wait,
--    so it is not hidden here.
-- 2. v_job_awaiting_content_scoped: the live jobs that wait, with the reason and the state of their
--    FETCH_JOB_CONTENT task, so the owner can see what is waiting and why.
-- 3. v_canonical_shortlist_scoped (last defined in 093) keeps every column and adds one condition: the job's
--    content must be complete. Every list built on it (Review, Priority, Apply Now, Track, status buckets)
--    therefore excludes awaiting-content jobs. Rejected-audit rows are not touched.
--
-- Additive: two new views and one replaced view with the same columns. Nothing is deleted or rewritten, and
-- the stored decisions stay on the job, so the jobs return to the lists the moment their content is complete.
--
-- Contract (amends the migration 112 line "every non-archived job is in exactly one status bucket"): a live job
-- is in exactly one of (a) a status bucket of v_job_status_buckets_scoped, or (b) v_job_awaiting_content_scoped.
-- (b) holds the live jobs without complete content that carry no hard rejection and are not manually removed.
-- A hard-rejected or removed job stays in its REJECTED / REMOVED bucket (the Rejected audit list) whatever its
-- description, because a rejection is not a recommendation. total_jobs of v_job_status_bucket_counts_scoped plus
-- awaiting_count of v_job_awaiting_content_counts_scoped is the number of live jobs.
--
-- Rollback (exact): run the CREATE OR REPLACE VIEW v_canonical_shortlist_scoped statement of
-- migrations/093_reversible_job_archiving.sql (from "CREATE OR REPLACE VIEW v_canonical_shortlist_scoped AS"
-- to its terminating "archived_at IS NULL;"), then
--   DROP VIEW IF EXISTS v_job_awaiting_content_counts_scoped;
--   DROP VIEW IF EXISTS v_job_awaiting_content_scoped;
--   DROP VIEW IF EXISTS v_job_content_state;
-- src/tests/ingestion/awaitingContent.integration.test.ts runs this rollback and checks the result.

CREATE OR REPLACE VIEW v_job_content_state AS
SELECT
  canonical.workspace_id,
  canonical.id AS canonical_job_id,
  target_version.id AS job_version_id,
  canonical.description_quality_status,
  (
    canonical.description_quality_status = 'COMPLETE'
    AND (COALESCE(evidence.has_evidence, FALSE) OR NOT COALESCE(evidence.has_observation, FALSE))
  ) AS content_complete,
  CASE
    WHEN canonical.description_quality_status IS DISTINCT FROM 'COMPLETE' THEN 'DESCRIPTION_NOT_COMPLETE'
    WHEN COALESCE(evidence.has_observation, FALSE) AND NOT COALESCE(evidence.has_evidence, FALSE) THEN 'NO_RETRIEVED_POSTING_EVIDENCE'
    ELSE NULL
  END AS awaiting_reason
FROM canonical_jobs canonical
LEFT JOIN LATERAL (
  SELECT version.id
  FROM job_versions version
  WHERE version.workspace_id = canonical.workspace_id
    AND version.canonical_job_id = canonical.id
  ORDER BY (version.id = canonical.latest_job_version_id) DESC, version.observed_at DESC, version.id DESC
  LIMIT 1
) target_version ON TRUE
LEFT JOIN LATERAL (
  SELECT TRUE AS has_observation,
         COALESCE(BOOL_OR(
           observation.source_name <> 'GMAIL_ALERT'
           OR observation.raw_payload->>'source_content_status' = 'COMPLETE'
         ), FALSE) AS has_evidence
  FROM raw_job_observations observation
  WHERE observation.workspace_id = canonical.workspace_id
    AND observation.job_version_id = target_version.id
  HAVING COUNT(*) > 0
) evidence ON TRUE;

COMMENT ON VIEW v_job_content_state IS
  'One row per canonical job: content_complete is true only when the description is COMPLETE and the current version has retrieved-posting evidence (a Gmail alert alone does not count). SQL statement of sourceContentEvidencePredicate in src/pipeline/descriptionQuality.ts.';

CREATE OR REPLACE VIEW v_job_awaiting_content_scoped AS
SELECT
  canonical.workspace_id,
  canonical.id AS canonical_job_id,
  state.job_version_id,
  canonical.normalized_title AS title,
  canonical.company_name AS company,
  state.awaiting_reason,
  seen.first_seen_at,
  seen.last_seen_at,
  fetch_task.task_status AS fetch_task_status,
  fetch_task.task_count AS fetch_task_count
FROM canonical_jobs canonical
JOIN v_job_content_state state
  ON state.workspace_id = canonical.workspace_id
 AND state.canonical_job_id = canonical.id
CROSS JOIN LATERAL (
  SELECT MIN(observation.retrieved_at) AS first_seen_at, MAX(observation.retrieved_at) AS last_seen_at
  FROM job_versions any_version
  JOIN raw_job_observations observation
    ON observation.workspace_id = any_version.workspace_id
   AND observation.job_version_id = any_version.id
  WHERE any_version.workspace_id = canonical.workspace_id
    AND any_version.canonical_job_id = canonical.id
) seen
LEFT JOIN LATERAL (
  SELECT (ARRAY_AGG(task.status ORDER BY task.created_at DESC, task.id DESC))[1] AS task_status,
         COUNT(*)::int AS task_count
  FROM pipeline_tasks task
  WHERE task.workspace_id = canonical.workspace_id
    AND task.task_type = 'FETCH_JOB_CONTENT'
    AND (
      task.payload->>'canonical_job_id' = canonical.id::text
      OR task.payload->>'job_version_id' = state.job_version_id::text
      OR task.payload->>'observation_id' IN (
        SELECT observation.id::text
        FROM raw_job_observations observation
        WHERE observation.workspace_id = canonical.workspace_id
          AND observation.job_version_id = state.job_version_id
      )
    )
) fetch_task ON TRUE
WHERE canonical.is_test_fixture = FALSE
  AND canonical.archived_at IS NULL
  AND COALESCE(canonical.processing_state, canonical.processing_status) NOT IN ('MANUALLY_REMOVED', 'HARD_REJECTED')
  AND NOT state.content_complete;

CREATE OR REPLACE VIEW v_job_awaiting_content_counts_scoped AS
SELECT
  workspace.id AS workspace_id,
  COUNT(awaiting.canonical_job_id)::int AS awaiting_count,
  COUNT(*) FILTER (WHERE awaiting.fetch_task_count = 0)::int AS awaiting_without_fetch_task_count
FROM workspaces AS workspace
LEFT JOIN v_job_awaiting_content_scoped AS awaiting ON awaiting.workspace_id = workspace.id
GROUP BY workspace.id;

COMMENT ON VIEW v_job_awaiting_content_counts_scoped IS
  'Per workspace: live jobs waiting for their posting text, and how many of them have no FETCH_JOB_CONTENT task.';

COMMENT ON VIEW v_job_awaiting_content_scoped IS
  'Live, not hard-rejected jobs waiting for their posting text ("awaiting content"): no gate result, lane or recommendation is shown for them. fetch_task_status is the latest FETCH_JOB_CONTENT task for the job, NULL when none exists.';

CREATE OR REPLACE VIEW v_canonical_shortlist_scoped AS
SELECT
  canonical.workspace_id,
  shortlist.*,
  CASE
    WHEN blocked.blocked_task_count > 0 THEN 'BLOCKED_DEPENDENCY'
    WHEN shortlist.gate_status = 'PASS' AND (
      active_profile.id IS NULL
      OR target_version.active_requirement_set_id IS NULL
      OR match_run.id IS NULL
      OR match_run.status <> 'COMPLETED'
      OR match_run.canonical_job_id IS DISTINCT FROM canonical.id
      OR match_run.job_version_id IS DISTINCT FROM target_version.id
      OR match_run.profile_version_id IS DISTINCT FROM active_profile.id
      OR match_run.requirement_set_id IS DISTINCT FROM target_version.active_requirement_set_id
      OR match_run.job_content_hash IS DISTINCT FROM target_version.content_hash
      OR match_run.context_fingerprint IS NULL
    ) THEN 'MATCH_STALE'
    WHEN shortlist.gate_status = 'PASS' AND (
      deterministic_decision.id IS NULL
      OR deterministic_decision.canonical_job_id IS DISTINCT FROM canonical.id
      OR deterministic_decision.job_version_id IS DISTINCT FROM target_version.id
      OR deterministic_decision.match_run_id IS DISTINCT FROM match_run.id
      OR deterministic_decision.context_fingerprint IS NULL
    ) THEN 'DECISION_STALE'
    WHEN shortlist.gate_status = 'PASS' AND latest_evaluation.id IS NULL THEN 'EVALUATION_MISSING'
    WHEN shortlist.gate_status = 'PASS' AND (
      latest_evaluation.profile_version_id IS DISTINCT FROM active_profile.id
      OR latest_evaluation.canonical_job_id IS DISTINCT FROM canonical.id
      OR latest_evaluation.job_version_id IS DISTINCT FROM target_version.id
      OR latest_evaluation.match_run_id IS DISTINCT FROM match_run.id
      OR latest_evaluation.deterministic_decision_id IS DISTINCT FROM deterministic_decision.id
      OR latest_evaluation.job_content_hash IS DISTINCT FROM target_version.content_hash
      OR latest_evaluation.context_fingerprint IS NULL
    ) THEN 'EVALUATION_STALE'
    WHEN shortlist.version_mismatch THEN 'EVALUATION_STALE'
    ELSE 'CURRENT_OR_NOT_APPLICABLE'
  END AS current_artifact_status,
  CASE
    WHEN blocked.blocked_task_count > 0 THEN blocked.blocked_reason
    WHEN shortlist.gate_status = 'PASS' AND active_profile.id IS NULL THEN 'NO_ACTIVE_PROFILE'
    WHEN shortlist.gate_status = 'PASS' AND target_version.active_requirement_set_id IS NULL THEN 'NO_ACTIVE_REQUIREMENT_SET'
    WHEN shortlist.gate_status = 'PASS' AND match_run.id IS NULL THEN 'NO_CURRENT_MATCH_RUN'
    WHEN shortlist.gate_status = 'PASS' AND match_run.status <> 'COMPLETED' THEN 'MATCH_RUN_NOT_COMPLETED'
    WHEN shortlist.gate_status = 'PASS' AND match_run.canonical_job_id IS DISTINCT FROM canonical.id THEN 'MATCH_CANONICAL_JOB_STALE'
    WHEN shortlist.gate_status = 'PASS' AND match_run.job_version_id IS DISTINCT FROM target_version.id THEN 'MATCH_JOB_VERSION_STALE'
    WHEN shortlist.gate_status = 'PASS' AND match_run.profile_version_id IS DISTINCT FROM active_profile.id THEN 'MATCH_PROFILE_VERSION_STALE'
    WHEN shortlist.gate_status = 'PASS' AND match_run.requirement_set_id IS DISTINCT FROM target_version.active_requirement_set_id THEN 'MATCH_REQUIREMENT_SET_STALE'
    WHEN shortlist.gate_status = 'PASS' AND match_run.job_content_hash IS DISTINCT FROM target_version.content_hash THEN 'MATCH_JOB_CONTENT_STALE'
    WHEN shortlist.gate_status = 'PASS' AND match_run.context_fingerprint IS NULL THEN 'MATCH_CONTEXT_UNPROVABLE'
    WHEN shortlist.gate_status = 'PASS' AND deterministic_decision.id IS NULL THEN 'NO_CURRENT_DETERMINISTIC_DECISION'
    WHEN shortlist.gate_status = 'PASS' AND deterministic_decision.canonical_job_id IS DISTINCT FROM canonical.id THEN 'DECISION_CANONICAL_JOB_STALE'
    WHEN shortlist.gate_status = 'PASS' AND deterministic_decision.job_version_id IS DISTINCT FROM target_version.id THEN 'DECISION_JOB_VERSION_STALE'
    WHEN shortlist.gate_status = 'PASS' AND deterministic_decision.match_run_id IS DISTINCT FROM match_run.id THEN 'DECISION_MATCH_RUN_STALE'
    WHEN shortlist.gate_status = 'PASS' AND deterministic_decision.context_fingerprint IS NULL THEN 'DECISION_CONTEXT_UNPROVABLE'
    WHEN shortlist.gate_status = 'PASS' AND latest_evaluation.id IS NULL THEN 'NO_CURRENT_AI_EVALUATION'
    WHEN shortlist.gate_status = 'PASS' AND latest_evaluation.context_fingerprint IS NULL THEN 'EVALUATION_CONTEXT_UNPROVABLE'
    WHEN shortlist.version_mismatch THEN 'NO_CURRENT_EVALUATION_FOR_DISPLAYED_VERSION'
    ELSE NULL
  END AS current_artifact_reason,
  blocked.blocked_task_count
FROM canonical_jobs canonical
JOIN v_canonical_shortlist shortlist
  ON shortlist.canonical_job_id = canonical.id
LEFT JOIN LATERAL (
  SELECT version.id, version.active_requirement_set_id, version.content_hash
  FROM job_versions version
  WHERE version.workspace_id = canonical.workspace_id
    AND version.id = shortlist.job_version_id::uuid
  LIMIT 1
) target_version ON TRUE
LEFT JOIN LATERAL (
  SELECT profile.id
  FROM profile_versions profile
  WHERE profile.workspace_id = canonical.workspace_id
    AND profile.status = 'ACTIVE'
  ORDER BY profile.created_at DESC
  LIMIT 1
) active_profile ON TRUE
LEFT JOIN LATERAL (
  SELECT candidate.id, candidate.status, candidate.canonical_job_id,
         candidate.job_version_id, candidate.profile_version_id,
         candidate.requirement_set_id, candidate.job_content_hash,
         candidate.context_fingerprint
  FROM match_runs candidate
  WHERE candidate.workspace_id = canonical.workspace_id
    AND candidate.id = canonical.latest_match_run_id
  LIMIT 1
) match_run ON TRUE
LEFT JOIN LATERAL (
  SELECT candidate.id, candidate.canonical_job_id, candidate.job_version_id,
         candidate.match_run_id, candidate.context_fingerprint
  FROM deterministic_decisions candidate
  WHERE candidate.workspace_id = canonical.workspace_id
    AND candidate.id = canonical.latest_deterministic_decision_id
  LIMIT 1
) deterministic_decision ON TRUE
LEFT JOIN LATERAL (
  SELECT candidate.id, candidate.canonical_job_id, candidate.job_version_id,
         candidate.profile_version_id, candidate.match_run_id,
         candidate.deterministic_decision_id, candidate.job_content_hash,
         candidate.context_fingerprint
  FROM ai_evaluations candidate
  WHERE candidate.workspace_id = canonical.workspace_id
    AND candidate.canonical_job_id = canonical.id
    AND candidate.job_version_id = shortlist.job_version_id::uuid
  ORDER BY candidate.evaluated_at DESC, candidate.id DESC
  LIMIT 1
) latest_evaluation ON TRUE
LEFT JOIN LATERAL (
  SELECT COUNT(*)::int AS blocked_task_count,
         MAX(task.blocked_reason) AS blocked_reason
  FROM pipeline_tasks task
  WHERE task.workspace_id = canonical.workspace_id
    AND task.status = 'BLOCKED_DEPENDENCY'
    AND (task.payload->>'canonical_job_id' = canonical.id::text
      OR task.payload->>'job_version_id' = shortlist.job_version_id::text)
) blocked ON TRUE
WHERE canonical.is_test_fixture = FALSE
  AND canonical.archived_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM v_job_content_state content_state
    WHERE content_state.workspace_id = canonical.workspace_id
      AND content_state.canonical_job_id = canonical.id
      AND content_state.content_complete
  );

COMMENT ON VIEW v_canonical_shortlist_scoped IS
  'Active canonical shortlist only, and only jobs whose posting content is complete (v_job_content_state); archived jobs remain available through v_archived_jobs_scoped and application history, and awaiting-content jobs through v_job_awaiting_content_scoped.';
