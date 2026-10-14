-- Migration 059: Dashboard and pipeline display semantics
--
-- Goals:
-- 1. Authoritative dashboard summary read model (v_job_engine_dashboard_summary_scoped)
--    aggregating exact counts over non-fixture canonical jobs without UI-level list limits.
-- 2. Correct pipeline_display_category in v_canonical_shortlist_actions_scoped so terminal
--    recommendation outcomes (PRIORITY, REVIEW, TRACK, SKIP) and AI_EVALUATED are COMPLETED,
--    rather than erroneously classified as PROCESSING_AUTOMATICALLY.

-- 1. Correct v_canonical_shortlist_actions_scoped
CREATE OR REPLACE VIEW v_canonical_shortlist_actions_scoped AS
SELECT
  shortlist.*,
  COALESCE(action.verification_question_id IS NOT NULL, FALSE) AS requires_user_action,
  action.action_type AS user_action_type,
  action.action_category AS user_action_category,
  action.action_status AS user_action_status,
  COALESCE(technical_error.error_count, 0)::int AS technical_error_count,
  CASE
    -- Priority 1: Unresolved explicit open user verification
    WHEN action.verification_question_id IS NOT NULL THEN 'USER_ACTION_REQUIRED'
    -- Priority 2: Genuine systemic/support failure
    WHEN COALESCE(technical_error.error_count, 0) > 0
      OR shortlist.processing_state = 'PROCESSING_ERROR' THEN 'TECHNICAL_ERROR'
    -- Priority 3: Terminal negative outcomes
    WHEN shortlist.processing_state IN ('HARD_REJECTED', 'UNMATCHED') THEN 'REJECTED_UNMATCHED'
    -- Priority 4: Terminal completed recommendations
    WHEN shortlist.recommendation_outcome IN ('PRIORITY', 'REVIEW', 'TRACK', 'SKIP') THEN 'COMPLETED'
    -- Priority 5: AI evaluated state with final outcome
    WHEN shortlist.processing_state IN ('AI_EVALUATED', 'EVALUATED') THEN 'COMPLETED'
    -- Priority 6: Genuinely in-flight machine states
    WHEN shortlist.processing_state IN (
      'RAW_STAGED', 'PREQUALIFIED', 'ROUTING_DEFERRED', 'LANE_ROUTED',
      'QUEUED_FOR_AI', 'EVALUATING', 'RETRY_WAIT', 'NEEDS_VERIFICATION'
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
    SELECT queue.id
    FROM evaluation_queue queue
    WHERE queue.workspace_id = shortlist.workspace_id
      AND queue.canonical_job_id = shortlist.canonical_job_id
      AND queue.job_version_id = shortlist.job_version_id::uuid
      AND queue.status = 'NEEDS_MANUAL_REVIEW'
  ) technical_error_rows
) technical_error ON TRUE;

-- 2. Authoritative dashboard summary read model
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
        'QUEUED_FOR_AI', 'EVALUATING', 'RETRY_WAIT', 'NEEDS_VERIFICATION'
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
    SELECT task.id FROM pipeline_tasks task WHERE task.workspace_id = w.id AND task.status = 'DEAD_LETTER'
    UNION ALL
    SELECT q.id FROM evaluation_queue q WHERE q.workspace_id = w.id AND q.status = 'NEEDS_MANUAL_REVIEW'
  ) all_errs
) err ON TRUE
GROUP BY w.id, act.action_count, err.error_count;

COMMENT ON VIEW v_canonical_shortlist_actions_scoped IS
  'Canonical shortlist with authoritative user-action, terminal recommendation, and pipeline-display projections.';
COMMENT ON VIEW v_job_engine_dashboard_summary_scoped IS
  'Authoritative aggregate dashboard summary metrics for non-fixture canonical jobs per workspace.';
