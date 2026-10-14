-- Migration 061: Exclude stale quarantined evaluation rows from active error metrics.
--
-- Migration 044 intentionally quarantined legacy evaluation rows as
-- NEEDS_MANUAL_REVIEW when they had no current profile/match/decision context.
-- Preserve those rows as audit history, but do not surface them as active
-- technical errors in the dashboard projection.

CREATE OR REPLACE VIEW v_current_evaluation_errors AS
SELECT q.*
FROM evaluation_queue q
WHERE q.status = 'NEEDS_MANUAL_REVIEW'
  AND EXISTS (
    SELECT 1
    FROM canonical_jobs c
    JOIN job_versions jv
      ON jv.workspace_id = c.workspace_id
     AND jv.id = c.latest_job_version_id
    JOIN profile_versions pv
      ON pv.workspace_id = c.workspace_id
     AND pv.id = q.profile_version_id
     AND pv.status = 'ACTIVE'
    JOIN match_runs mr
      ON mr.workspace_id = c.workspace_id
     AND mr.id = q.match_run_id
     AND mr.canonical_job_id = c.id
     AND mr.job_version_id = jv.id
     AND mr.profile_version_id = pv.id
     AND mr.requirement_set_id = jv.active_requirement_set_id
     AND mr.job_content_hash = jv.content_hash
     AND mr.status = 'COMPLETED'
    JOIN deterministic_decisions dd
      ON dd.workspace_id = c.workspace_id
     AND dd.id = q.deterministic_decision_id
     AND dd.canonical_job_id = c.id
     AND dd.job_version_id = jv.id
     AND dd.match_run_id = mr.id
     AND dd.context_fingerprint = q.context_fingerprint
    WHERE c.workspace_id = q.workspace_id
      AND c.id = q.canonical_job_id
      AND q.job_version_id = jv.id
      AND q.job_content_hash = jv.content_hash
  );

CREATE OR REPLACE VIEW v_canonical_shortlist_actions_scoped AS
SELECT
  shortlist.*,
  COALESCE(action.verification_question_id IS NOT NULL, FALSE) AS requires_user_action,
  action.action_type AS user_action_type,
  action.action_category AS user_action_category,
  action.action_status AS user_action_status,
  COALESCE(technical_error.error_count, 0)::int AS technical_error_count,
  CASE
    WHEN action.verification_question_id IS NOT NULL THEN 'USER_ACTION_REQUIRED'
    WHEN COALESCE(technical_error.error_count, 0) > 0
      OR shortlist.processing_state = 'PROCESSING_ERROR' THEN 'TECHNICAL_ERROR'
    WHEN shortlist.processing_state IN ('HARD_REJECTED', 'UNMATCHED') THEN 'REJECTED_UNMATCHED'
    WHEN shortlist.recommendation_outcome IN ('PRIORITY', 'REVIEW', 'TRACK', 'SKIP') THEN 'COMPLETED'
    WHEN shortlist.processing_state IN ('AI_EVALUATED', 'EVALUATED') THEN 'COMPLETED'
    WHEN shortlist.processing_state IN (
      'RAW_STAGED', 'PREQUALIFIED', 'ROUTING_DEFERRED', 'LANE_ROUTED',
      'QUEUED_FOR_AI', 'EVALUATING', 'RETRY_WAIT', 'NEEDS_VERIFICATION', 'DEFERRED_BUDGET'
    ) THEN 'PROCESSING_AUTOMATICALLY'
    ELSE 'COMPLETED'
  END AS pipeline_display_category
FROM v_canonical_shortlist_scoped shortlist
LEFT JOIN v_current_user_actions action
  ON action.workspace_id = shortlist.workspace_id
 AND action.canonical_job_id = shortlist.canonical_job_id
 AND action.job_version_id = shortlist.job_version_id
LEFT JOIN LATERAL (
  SELECT COUNT(*)::int AS error_count
  FROM (
    SELECT task.id
    FROM pipeline_tasks task
    WHERE task.workspace_id = shortlist.workspace_id
      AND task.status = 'DEAD_LETTER'
      AND (
        task.payload->>'canonical_job_id' = shortlist.canonical_job_id::text
        OR task.payload->>'job_version_id' = shortlist.job_version_id::text
      )
    UNION ALL
    SELECT current_error.id
    FROM v_current_evaluation_errors current_error
    WHERE current_error.workspace_id = shortlist.workspace_id
      AND current_error.canonical_job_id = shortlist.canonical_job_id
      AND current_error.job_version_id = shortlist.job_version_id::uuid
  ) technical_error_rows
) technical_error ON TRUE;

CREATE OR REPLACE VIEW v_job_engine_dashboard_summary_scoped AS
SELECT
  w.id AS workspace_id,
  COUNT(c.id) FILTER (WHERE NOT c.is_test_fixture)::int AS total_jobs,
  COUNT(c.id) FILTER (WHERE NOT c.is_test_fixture AND c.gate_decision = 'PASS')::int AS gate_passed,
  COUNT(c.id) FILTER (WHERE NOT c.is_test_fixture AND COALESCE(c.processing_state, c.processing_status) = 'HARD_REJECTED')::int AS hard_rejected,
  COUNT(c.id) FILTER (WHERE NOT c.is_test_fixture AND COALESCE(c.processing_state, c.processing_status) = 'UNMATCHED')::int AS unmatched,
  COUNT(c.id) FILTER (
    WHERE NOT c.is_test_fixture
      AND COALESCE(c.processing_state, c.processing_status) NOT IN ('HARD_REJECTED', 'UNMATCHED')
      AND c.recommendation_outcome IS NULL
      AND COALESCE(c.processing_state, c.processing_status) IN (
        'RAW_STAGED', 'PREQUALIFIED', 'ROUTING_DEFERRED', 'LANE_ROUTED',
        'QUEUED_FOR_AI', 'EVALUATING', 'RETRY_WAIT', 'NEEDS_VERIFICATION', 'DEFERRED_BUDGET'
      )
  )::int AS processing,
  COALESCE(err.error_count, 0)::int AS technical_errors,
  COALESCE(act.action_count, 0)::int AS user_action_required,
  COUNT(c.id) FILTER (WHERE NOT c.is_test_fixture AND c.recommendation_outcome = 'PRIORITY')::int AS priority_count,
  COUNT(c.id) FILTER (WHERE NOT c.is_test_fixture AND c.recommendation_outcome = 'REVIEW')::int AS review_count,
  COUNT(c.id) FILTER (WHERE NOT c.is_test_fixture AND c.recommendation_outcome = 'TRACK')::int AS track_count,
  COUNT(c.id) FILTER (WHERE NOT c.is_test_fixture AND c.recommendation_outcome = 'SKIP')::int AS skip_count,
  COUNT(c.id) FILTER (WHERE NOT c.is_test_fixture AND c.recommendation_outcome IN ('PRIORITY', 'REVIEW', 'TRACK'))::int AS recommended_count,
  COUNT(c.id) FILTER (WHERE NOT c.is_test_fixture AND c.recommendation_outcome IN ('PRIORITY', 'REVIEW'))::int AS apply_now_count,
  COUNT(c.id) FILTER (WHERE NOT c.is_test_fixture AND COALESCE(c.processing_state, c.processing_status) = 'PREQUALIFIED')::int AS prequalified_count,
  COUNT(c.id) FILTER (WHERE NOT c.is_test_fixture AND COALESCE(c.processing_state, c.processing_status) = 'LANE_ROUTED')::int AS lane_routed_count,
  COUNT(c.id) FILTER (WHERE NOT c.is_test_fixture AND COALESCE(c.processing_state, c.processing_status) = 'MATCHED')::int AS matched_count,
  COUNT(c.id) FILTER (WHERE NOT c.is_test_fixture AND COALESCE(c.processing_state, c.processing_status) = 'AI_EVALUATED')::int AS ai_evaluated_count,
  COUNT(c.id) FILTER (WHERE NOT c.is_test_fixture AND c.recommendation_outcome IS NOT NULL)::int AS decision_complete_count
FROM workspaces w
LEFT JOIN canonical_jobs c ON c.workspace_id = w.id
LEFT JOIN LATERAL (
  SELECT COUNT(*)::int AS action_count
  FROM v_current_user_actions a
  WHERE a.workspace_id = w.id
) act ON TRUE
LEFT JOIN LATERAL (
  SELECT COUNT(*)::int AS error_count
  FROM (
    SELECT task.id
    FROM pipeline_tasks task
    WHERE task.workspace_id = w.id AND task.status = 'DEAD_LETTER'
    UNION ALL
    SELECT current_error.id
    FROM v_current_evaluation_errors current_error
    WHERE current_error.workspace_id = w.id
  ) all_errs
) err ON TRUE
GROUP BY w.id, act.action_count, err.error_count;

COMMENT ON VIEW v_current_evaluation_errors IS
  'Current evaluation manual-review rows with complete active profile, match, decision, version, hash, and context identity. Legacy quarantined rows remain audit history but are excluded from active error metrics.';
