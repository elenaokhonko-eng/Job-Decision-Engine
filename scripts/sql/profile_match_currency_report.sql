-- READ-ONLY report: eligible routed jobs by deterministic outcome, whether their latest match was
-- made against the active profile version, how many need a profile re-match, and how many have a
-- path to AI enqueue.
--
-- It reads only and needs no migration. Run it inside a read-only transaction, for example:
--   BEGIN READ ONLY; \i scripts/sql/profile_match_currency_report.sql ROLLBACK;
--
-- Eligible jobs: not archived, state LANE_ROUTED, MATCHED, QUEUED_FOR_AI or DEFERRED_BUDGET, a
-- routed primary lane, recommendation_eligibility ELIGIBLE, outcome PRIORITY, REVIEW or TRACK.
-- Only PRIORITY and REVIEW are AI-evaluated (src/pipeline/profileMatchCurrency.ts); TRACK jobs are
-- re-matched deterministically but never enqueued for AI unless the new decision promotes them.
--
-- Columns, one row per outcome plus an ALL row:
--   eligible_jobs                 eligible jobs in this outcome
--   ai_evaluated_outcome          jobs whose outcome is AI-evaluated (PRIORITY/REVIEW)
--   current_profile_match         latest match is for the latest job version, the unique ACTIVE
--                                 profile, the active requirement set and content hash, COMPLETED
--   needs_rematch                 latest match was made against a superseded profile version
--   other_match_not_current       neither of the above (no match, or requirement/content drift)
--   decision_on_current_match     current_profile_match and the latest decision uses that match
--   rematch_task_queued           a MATCH_PROFILE_EVIDENCE re-match exists for the superseded match
--   enqueue_task_any              any ENQUEUE_EXPLANATION task exists for the latest job version
--   enqueue_task_outstanding      an ENQUEUE_EXPLANATION task is PENDING/RUNNING/RETRY_WAIT/BLOCKED
--   queued_or_evaluated_current   an active queue row or an AI evaluation exists for the current
--                                 profile, match and decision
--   enqueue_path_after_fix        AI-evaluated outcome with a current match (the seeder queues
--                                 ENQUEUE_EXPLANATION; a stale decision is re-decided first) or
--                                 needing a re-match (the seeder queues MATCH_PROFILE_EVIDENCE,
--                                 then DECIDE_RECOMMENDATION and ENQUEUE_EXPLANATION follow)
--   excluded_from_ai_by_outcome   TRACK jobs: deterministic only, by design

WITH active_profile AS (
  SELECT workspace_id,
         CASE WHEN COUNT(*) = 1 THEN MIN(id::text)::uuid END AS profile_version_id
  FROM profile_versions
  WHERE status = 'ACTIVE'
  GROUP BY workspace_id
),
eligible AS (
  SELECT c.workspace_id,
         c.id AS canonical_job_id,
         c.latest_job_version_id AS job_version_id,
         c.recommendation_outcome AS outcome,
         c.recommendation_outcome IN ('PRIORITY', 'REVIEW') AS ai_evaluated_outcome,
         ap.profile_version_id AS active_profile_version_id,
         mr.id AS match_run_id,
         dd.id AS decision_id,
         COALESCE(
           mr.id IS NOT NULL
           AND mr.job_version_id = jv.id
           AND mr.profile_version_id = ap.profile_version_id
           AND mr.requirement_set_id = jv.active_requirement_set_id
           AND mr.job_content_hash = jv.content_hash
           AND mr.status = 'COMPLETED',
           FALSE
         ) AS current_profile_match,
         COALESCE(
           mr.id IS NOT NULL
           AND mr.job_version_id = c.latest_job_version_id
           AND ap.profile_version_id IS NOT NULL
           AND mr.profile_version_id IS DISTINCT FROM ap.profile_version_id,
           FALSE
         ) AS needs_rematch,
         COALESCE(
           dd.id IS NOT NULL
           AND dd.canonical_job_id = c.id
           AND dd.job_version_id = c.latest_job_version_id
           AND dd.match_run_id = c.latest_match_run_id
           AND dd.context_fingerprint IS NOT NULL,
           FALSE
         ) AS decision_on_latest_match,
         jv.content_hash AS job_content_hash
  FROM canonical_jobs c
  LEFT JOIN job_versions jv
    ON jv.workspace_id = c.workspace_id
   AND jv.id = c.latest_job_version_id
  LEFT JOIN active_profile ap
    ON ap.workspace_id = c.workspace_id
  LEFT JOIN match_runs mr
    ON mr.workspace_id = c.workspace_id
   AND mr.id = c.latest_match_run_id
  LEFT JOIN deterministic_decisions dd
    ON dd.workspace_id = c.workspace_id
   AND dd.id = c.latest_deterministic_decision_id
  WHERE c.archived_at IS NULL
    AND COALESCE(c.processing_state, c.processing_status) IN ('LANE_ROUTED', 'MATCHED', 'QUEUED_FOR_AI', 'DEFERRED_BUDGET')
    AND c.primary_lane IS NOT NULL
    AND c.primary_lane <> 'UNCLASSIFIED'
    AND COALESCE(c.recommendation_eligibility, 'VERIFY') = 'ELIGIBLE'
    AND c.recommendation_outcome IN ('PRIORITY', 'REVIEW', 'TRACK')
),
per_job AS (
  SELECT e.*,
         EXISTS (
           SELECT 1
           FROM pipeline_tasks t
           WHERE t.workspace_id = e.workspace_id
             AND t.task_type = 'MATCH_PROFILE_EVIDENCE'
             AND t.payload->>'job_version_id' = e.job_version_id::text
             AND t.payload->>'superseded_match_run_id' = e.match_run_id::text
         ) AS rematch_task_queued,
         EXISTS (
           SELECT 1
           FROM pipeline_tasks t
           WHERE t.workspace_id = e.workspace_id
             AND t.task_type = 'ENQUEUE_EXPLANATION'
             AND t.payload->>'job_version_id' = e.job_version_id::text
         ) AS enqueue_task_any,
         EXISTS (
           SELECT 1
           FROM pipeline_tasks t
           WHERE t.workspace_id = e.workspace_id
             AND t.task_type = 'ENQUEUE_EXPLANATION'
             AND t.payload->>'job_version_id' = e.job_version_id::text
             AND t.status IN ('PENDING', 'RUNNING', 'RETRY_WAIT', 'BLOCKED_DEPENDENCY')
         ) AS enqueue_task_outstanding,
         (
           EXISTS (
             SELECT 1
             FROM evaluation_queue eq
             WHERE eq.workspace_id = e.workspace_id
               AND eq.job_version_id = e.job_version_id
               AND eq.profile_version_id = e.active_profile_version_id
               AND eq.match_run_id = e.match_run_id
               AND eq.deterministic_decision_id = e.decision_id
               AND eq.job_content_hash = e.job_content_hash
               AND eq.status IN ('PENDING', 'EVALUATING', 'RETRY_WAIT')
           )
           OR EXISTS (
             SELECT 1
             FROM ai_evaluations ae
             WHERE ae.workspace_id = e.workspace_id
               AND ae.job_version_id = e.job_version_id
               AND ae.profile_version_id = e.active_profile_version_id
               AND ae.match_run_id = e.match_run_id
               AND ae.deterministic_decision_id = e.decision_id
               AND ae.job_content_hash = e.job_content_hash
           )
         ) AS queued_or_evaluated_current
  FROM eligible e
)
SELECT COALESCE(outcome, 'ALL') AS outcome,
       COUNT(*)::int AS eligible_jobs,
       COUNT(*) FILTER (WHERE ai_evaluated_outcome)::int AS ai_evaluated_outcome,
       COUNT(*) FILTER (WHERE current_profile_match)::int AS current_profile_match,
       COUNT(*) FILTER (WHERE needs_rematch)::int AS needs_rematch,
       COUNT(*) FILTER (WHERE NOT current_profile_match AND NOT needs_rematch)::int AS other_match_not_current,
       COUNT(*) FILTER (WHERE current_profile_match AND decision_on_latest_match)::int AS decision_on_current_match,
       COUNT(*) FILTER (WHERE needs_rematch AND rematch_task_queued)::int AS rematch_task_queued,
       COUNT(*) FILTER (WHERE enqueue_task_any)::int AS enqueue_task_any,
       COUNT(*) FILTER (WHERE enqueue_task_outstanding)::int AS enqueue_task_outstanding,
       COUNT(*) FILTER (WHERE queued_or_evaluated_current)::int AS queued_or_evaluated_current,
       COUNT(*) FILTER (WHERE ai_evaluated_outcome AND (current_profile_match OR needs_rematch))::int
         AS enqueue_path_after_fix,
       COUNT(*) FILTER (WHERE NOT ai_evaluated_outcome)::int AS excluded_from_ai_by_outcome
FROM per_job
GROUP BY ROLLUP (outcome)
ORDER BY CASE COALESCE(outcome, 'ALL')
           WHEN 'PRIORITY' THEN 0
           WHEN 'REVIEW' THEN 1
           WHEN 'TRACK' THEN 2
           ELSE 3
         END;
