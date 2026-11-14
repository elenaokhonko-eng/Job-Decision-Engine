-- Migration 112: separate Rejected / Unmatched / Removed, per-job status buckets, actionable
-- technical-error read model and an audited support-action ledger.
--
-- 1. v_canonical_shortlist_actions_scoped (last defined in 061) counted every DEAD_LETTER task whose
--    payload named the canonical job, including PUBLISH_EMBEDDING tasks of a superseded job version.
--    src/tasks/deadLetterPolicy.ts already classifies those as STALE_HISTORICAL (repair_action
--    RECONCILED_STALE_SUPERSEDED_JOB_VERSION, or a payload version that is no longer the job's
--    latest version) and the pipeline health report ignores them, but the dashboard projection did
--    not: a job whose old version's embedding dead-lettered stayed in "Technical errors" forever,
--    with nothing to retry. The view is replaced with the same columns; only the technical-error
--    count now applies the same STALE_HISTORICAL rule.
--
-- 2. v_job_status_buckets_scoped gives every current, non-archived, non-fixture job exactly one
--    status bucket (REJECTED, UNMATCHED, REMOVED, TECHNICAL_ERROR, APPLY_NOW, NEEDS_VERIFICATION,
--    SKIP, REVIEW_AWAITING_AI, REVIEW_EVALUATED_NOT_READY, TRACK, PROCESSING) with the stored reason.
--    v_job_status_bucket_counts_scoped counts them per workspace; the buckets partition total_jobs.
--
-- 3. v_application_workspace_summary_scoped keeps every existing column (rejected_unmatched_count
--    stays for compatibility) and appends rejected_count, unmatched_count and removed_count, whose
--    sum equals rejected_unmatched_count. Archived jobs are excluded upstream
--    (v_canonical_shortlist_scoped and v_rejected_jobs_audit_scoped filter archived_at IS NULL).
--
-- 4. v_job_support_issues_scoped lists, for every job in the TECHNICAL_ERROR display category, one
--    row per issue class with the actions that can resolve it (available_actions). The API
--    (src/api/v2/supportIssuesRouter.ts) only executes an action the current row offers.
--
-- 5. job_support_actions is the append-only audit ledger of every support action taken from the
--    dashboard (fetch description, paste description, retry, dismiss).
--
-- Rollback: re-run the v_canonical_shortlist_actions_scoped definition from 061 and the
-- v_application_workspace_summary_scoped definition from 066 (CREATE OR REPLACE cannot drop the
-- appended columns, so DROP VIEW v_application_workspace_summary_scoped first, then recreate it from
-- 066); DROP VIEW v_job_support_issues_scoped, v_job_status_bucket_counts_scoped and
-- v_job_status_buckets_scoped. job_support_actions holds user-initiated audit history: drop it (and
-- the function job_support_actions_append_only) only with explicit human approval.

-- ============================================================================
-- 1) Technical-error count ignores stale superseded-version embedding dead letters
-- ============================================================================

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
      -- STALE_HISTORICAL in src/tasks/deadLetterPolicy.ts: an embedding of a superseded version.
      AND NOT (
        task.task_type = 'PUBLISH_EMBEDDING'
        AND (
          POSITION('RECONCILED_STALE_SUPERSEDED_JOB_VERSION' IN COALESCE(task.repair_action, '')) > 0
          OR (
            task.payload ? 'job_version_id'
            AND task.payload->>'job_version_id' <> shortlist.job_version_id::text
          )
        )
      )
    UNION ALL
    SELECT current_error.id
    FROM v_current_evaluation_errors current_error
    WHERE current_error.workspace_id = shortlist.workspace_id
      AND current_error.canonical_job_id = shortlist.canonical_job_id
      AND current_error.job_version_id = shortlist.job_version_id::uuid
  ) technical_error_rows
) technical_error ON TRUE;

-- ============================================================================
-- 2) One status bucket per current job
-- ============================================================================

CREATE OR REPLACE VIEW v_job_status_buckets_scoped AS
WITH apply_now_jobs AS (
  SELECT DISTINCT workspace_id, canonical_job_id
  FROM v_apply_now_jobs_scoped
),
track_jobs AS (
  SELECT DISTINCT workspace_id, canonical_job_id
  FROM v_track_jobs_scoped
),
shortlist_rows AS (
  SELECT
    shortlist.workspace_id,
    shortlist.canonical_job_id,
    shortlist.job_version_id::uuid AS job_version_id,
    shortlist.title,
    shortlist.company,
    shortlist.canonical_url,
    shortlist.source::text AS source,
    shortlist.processing_state::text AS processing_state,
    shortlist.gate_status,
    shortlist.recommendation_eligibility::text AS recommendation_eligibility,
    shortlist.recommendation_outcome::text AS recommendation_outcome,
    shortlist.rejection_codes,
    shortlist.pipeline_display_category,
    CASE
      WHEN shortlist.pipeline_display_category = 'TECHNICAL_ERROR' THEN 'TECHNICAL_ERROR'
      WHEN shortlist.pipeline_display_category = 'REJECTED_UNMATCHED'
        AND shortlist.processing_state = 'HARD_REJECTED' THEN 'REJECTED'
      WHEN shortlist.pipeline_display_category = 'REJECTED_UNMATCHED' THEN 'UNMATCHED'
      WHEN apply_now.canonical_job_id IS NOT NULL THEN 'APPLY_NOW'
      WHEN shortlist.pipeline_display_category = 'USER_ACTION_REQUIRED' THEN 'NEEDS_VERIFICATION'
      WHEN (shortlist.gate_status = 'NEEDS_VERIFICATION' OR shortlist.processing_state = 'NEEDS_VERIFICATION')
        AND shortlist.recommendation_outcome IS DISTINCT FROM 'SKIP' THEN 'NEEDS_VERIFICATION'
      WHEN shortlist.recommendation_outcome = 'SKIP' THEN 'SKIP'
      WHEN shortlist.recommendation_outcome IN ('PRIORITY', 'REVIEW')
        AND shortlist.processing_state NOT IN ('AI_EVALUATED', 'EVALUATED') THEN 'REVIEW_AWAITING_AI'
      WHEN shortlist.recommendation_outcome IN ('PRIORITY', 'REVIEW') THEN 'REVIEW_EVALUATED_NOT_READY'
      WHEN shortlist.recommendation_outcome = 'TRACK' AND track.canonical_job_id IS NOT NULL THEN 'TRACK'
      ELSE 'PROCESSING'
    END AS status_bucket,
    CASE
      WHEN shortlist.pipeline_display_category = 'TECHNICAL_ERROR' THEN shortlist.current_artifact_reason
      WHEN shortlist.pipeline_display_category = 'REJECTED_UNMATCHED' THEN canonical.rejection_reason
      WHEN shortlist.recommendation_outcome = 'TRACK' AND track.canonical_job_id IS NULL
        AND apply_now.canonical_job_id IS NULL THEN 'TRACK_DECISION_AWAITING_CURRENT_MATCH'
      ELSE NULL
    END AS status_reason,
    shortlist.observed_at,
    1 AS source_priority
  FROM v_canonical_shortlist_actions_scoped AS shortlist
  JOIN canonical_jobs AS canonical
    ON canonical.workspace_id = shortlist.workspace_id
   AND canonical.id = shortlist.canonical_job_id
  LEFT JOIN apply_now_jobs AS apply_now
    ON apply_now.workspace_id = shortlist.workspace_id
   AND apply_now.canonical_job_id = shortlist.canonical_job_id
  LEFT JOIN track_jobs AS track
    ON track.workspace_id = shortlist.workspace_id
   AND track.canonical_job_id = shortlist.canonical_job_id
),
audit_rows AS (
  SELECT
    rejected.workspace_id,
    rejected.id AS canonical_job_id,
    rejected.job_version_id,
    rejected.title,
    rejected.company,
    rejected.careers_portal_url AS canonical_url,
    rejected.source::text AS source,
    rejected.status::text AS processing_state,
    rejected.gate_status,
    NULL::text AS recommendation_eligibility,
    NULL::text AS recommendation_outcome,
    rejected.rejection_codes,
    'REJECTED_UNMATCHED'::text AS pipeline_display_category,
    CASE WHEN rejected.status = 'MANUALLY_REMOVED' THEN 'REMOVED' ELSE 'REJECTED' END AS status_bucket,
    rejected.rejection_reason AS status_reason,
    rejected."postedDate"::timestamptz AS observed_at,
    0 AS source_priority
  FROM v_rejected_jobs_audit_scoped AS rejected
)
SELECT DISTINCT ON (combined.workspace_id, combined.canonical_job_id)
  combined.workspace_id,
  combined.canonical_job_id,
  combined.job_version_id,
  combined.title,
  combined.company,
  combined.canonical_url,
  combined.source,
  combined.processing_state,
  combined.gate_status,
  combined.recommendation_eligibility,
  combined.recommendation_outcome,
  combined.rejection_codes,
  combined.pipeline_display_category,
  combined.status_bucket,
  combined.status_reason,
  combined.observed_at
FROM (
  SELECT * FROM audit_rows
  UNION ALL
  SELECT * FROM shortlist_rows
) AS combined
ORDER BY combined.workspace_id, combined.canonical_job_id, combined.source_priority;

CREATE OR REPLACE VIEW v_job_status_bucket_counts_scoped AS
SELECT
  workspace.id AS workspace_id,
  COUNT(bucket.canonical_job_id)::int AS total_jobs,
  COUNT(*) FILTER (WHERE bucket.status_bucket = 'APPLY_NOW')::int AS apply_now_count,
  COUNT(*) FILTER (WHERE bucket.status_bucket = 'REVIEW_AWAITING_AI')::int AS review_awaiting_ai_count,
  COUNT(*) FILTER (WHERE bucket.status_bucket = 'REVIEW_EVALUATED_NOT_READY')::int AS review_evaluated_not_ready_count,
  COUNT(*) FILTER (WHERE bucket.status_bucket = 'TRACK')::int AS track_count,
  COUNT(*) FILTER (WHERE bucket.status_bucket = 'NEEDS_VERIFICATION')::int AS needs_verification_count,
  COUNT(*) FILTER (WHERE bucket.status_bucket = 'PROCESSING')::int AS processing_count,
  COUNT(*) FILTER (WHERE bucket.status_bucket = 'SKIP')::int AS skip_count,
  COUNT(*) FILTER (WHERE bucket.status_bucket = 'TECHNICAL_ERROR')::int AS technical_error_count,
  COUNT(*) FILTER (WHERE bucket.status_bucket = 'REJECTED')::int AS rejected_count,
  COUNT(*) FILTER (WHERE bucket.status_bucket = 'UNMATCHED')::int AS unmatched_count,
  COUNT(*) FILTER (WHERE bucket.status_bucket = 'REMOVED')::int AS removed_count
FROM workspaces AS workspace
LEFT JOIN v_job_status_buckets_scoped AS bucket
  ON bucket.workspace_id = workspace.id
GROUP BY workspace.id;

-- ============================================================================
-- 3) Workspace summary: separate Rejected / Unmatched / Removed counts (appended columns)
-- ============================================================================

CREATE OR REPLACE VIEW v_application_workspace_summary_scoped AS
WITH current_job_rows AS (
  SELECT
    shortlist.workspace_id,
    shortlist.canonical_job_id,
    (shortlist.pipeline_display_category = 'PROCESSING_AUTOMATICALLY') AS is_processing,
    (shortlist.pipeline_display_category = 'REJECTED_UNMATCHED') AS is_rejected_unmatched,
    (shortlist.pipeline_display_category = 'REJECTED_UNMATCHED'
      AND shortlist.processing_state = 'HARD_REJECTED') AS is_rejected,
    (shortlist.pipeline_display_category = 'REJECTED_UNMATCHED'
      AND shortlist.processing_state IS DISTINCT FROM 'HARD_REJECTED') AS is_unmatched,
    FALSE AS is_removed
  FROM v_canonical_shortlist_actions_scoped AS shortlist
  UNION ALL
  SELECT
    rejected.workspace_id,
    rejected.id AS canonical_job_id,
    FALSE AS is_processing,
    TRUE AS is_rejected_unmatched,
    (rejected.status IS DISTINCT FROM 'MANUALLY_REMOVED') AS is_rejected,
    FALSE AS is_unmatched,
    (rejected.status = 'MANUALLY_REMOVED') AS is_removed
  FROM v_rejected_jobs_audit_scoped AS rejected
),
operational_jobs AS (
  SELECT
    workspace_id,
    canonical_job_id,
    BOOL_OR(is_processing) AS is_processing,
    BOOL_OR(is_rejected_unmatched) AS is_rejected_unmatched,
    BOOL_OR(is_removed) AS is_removed,
    BOOL_OR(is_rejected) AND NOT BOOL_OR(is_removed) AS is_rejected,
    BOOL_OR(is_unmatched) AND NOT BOOL_OR(is_removed) AND NOT BOOL_OR(is_rejected) AS is_unmatched
  FROM current_job_rows
  GROUP BY workspace_id, canonical_job_id
),
pipeline_counts AS (
  SELECT
    workspace_id,
    COUNT(*)::INTEGER AS total_jobs,
    COUNT(*) FILTER (WHERE is_processing)::INTEGER AS processing_count,
    COUNT(*) FILTER (WHERE is_rejected_unmatched)::INTEGER AS rejected_unmatched_count,
    COUNT(*) FILTER (WHERE is_rejected_unmatched AND is_rejected)::INTEGER AS rejected_count,
    COUNT(*) FILTER (WHERE is_rejected_unmatched AND is_unmatched)::INTEGER AS unmatched_count,
    COUNT(*) FILTER (WHERE is_rejected_unmatched AND is_removed)::INTEGER AS removed_count
  FROM operational_jobs
  GROUP BY workspace_id
),
apply_now_counts AS (
  SELECT workspace_id, COUNT(DISTINCT canonical_job_id)::INTEGER AS apply_now_count
  FROM v_apply_now_jobs_scoped
  GROUP BY workspace_id
),
track_counts AS (
  SELECT workspace_id, COUNT(DISTINCT canonical_job_id)::INTEGER AS track_count
  FROM v_track_jobs_scoped
  GROUP BY workspace_id
),
skip_counts AS (
  SELECT
    workspace_id,
    COUNT(DISTINCT canonical_job_id) FILTER (WHERE recommendation_outcome = 'SKIP')::INTEGER AS skip_count
  FROM v_canonical_shortlist_actions_scoped
  GROUP BY workspace_id
),
top_ten_counts AS (
  SELECT workspace_id, COUNT(DISTINCT canonical_job_id)::INTEGER AS top_ten_ready_count
  FROM v_top_ten_ready_jobs_scoped
  GROUP BY workspace_id
),
technical_error_counts AS (
  SELECT
    shortlist.workspace_id,
    SUM(GREATEST(
      COALESCE(shortlist.technical_error_count, 0),
      CASE WHEN shortlist.processing_state = 'PROCESSING_ERROR' THEN 1 ELSE 0 END
    ))::INTEGER AS technical_errors
  FROM v_canonical_shortlist_actions_scoped AS shortlist
  GROUP BY shortlist.workspace_id
),
application_counts AS (
  SELECT
    application.workspace_id,
    application.user_id,
    COUNT(*) FILTER (WHERE application.status IN (
      'APPLIED', 'ASSESSMENT', 'SUBMITTED', 'FOLLOW_UP', 'INTERVIEW',
      'OFFER', 'REJECTED', 'WITHDRAWN'
    ))::INTEGER AS applied_count
  FROM application_records AS application
  GROUP BY application.workspace_id, application.user_id
)
SELECT
  workspace.id AS workspace_id,
  membership.user_id,
  workspace_user.user_key,
  COALESCE(pipeline.total_jobs, 0)::INTEGER AS total_jobs,
  COALESCE(apply_now.apply_now_count, 0)::INTEGER AS apply_now_count,
  COALESCE(track.track_count, 0)::INTEGER AS track_count,
  COALESCE(pipeline.processing_count, 0)::INTEGER AS processing_count,
  COALESCE(pipeline.rejected_unmatched_count, 0)::INTEGER AS rejected_unmatched_count,
  COALESCE(applications.applied_count, 0)::INTEGER AS applied_count,
  COALESCE(errors.technical_errors, 0)::INTEGER AS technical_errors,
  COALESCE(skips.skip_count, 0)::INTEGER AS skip_count,
  COALESCE(top_ten.top_ten_ready_count, 0)::INTEGER AS top_ten_ready_count,
  COALESCE(pipeline.rejected_count, 0)::INTEGER AS rejected_count,
  COALESCE(pipeline.unmatched_count, 0)::INTEGER AS unmatched_count,
  COALESCE(pipeline.removed_count, 0)::INTEGER AS removed_count
FROM workspaces AS workspace
JOIN workspace_memberships AS membership
  ON membership.workspace_id = workspace.id
 AND membership.status = 'ACTIVE'
JOIN workspace_users AS workspace_user
  ON workspace_user.id = membership.user_id
LEFT JOIN pipeline_counts AS pipeline
  ON pipeline.workspace_id = workspace.id
LEFT JOIN apply_now_counts AS apply_now
  ON apply_now.workspace_id = workspace.id
LEFT JOIN track_counts AS track
  ON track.workspace_id = workspace.id
LEFT JOIN skip_counts AS skips
  ON skips.workspace_id = workspace.id
LEFT JOIN technical_error_counts AS errors
  ON errors.workspace_id = workspace.id
LEFT JOIN top_ten_counts AS top_ten
  ON top_ten.workspace_id = workspace.id
LEFT JOIN application_counts AS applications
  ON applications.workspace_id = workspace.id
 AND applications.user_id = membership.user_id;

-- ============================================================================
-- 4) Technical errors with the actions that resolve them
-- ============================================================================

CREATE OR REPLACE VIEW v_job_support_issues_scoped AS
WITH error_jobs AS (
  SELECT
    shortlist.workspace_id,
    shortlist.canonical_job_id,
    shortlist.job_version_id::uuid AS job_version_id,
    shortlist.title,
    shortlist.company,
    shortlist.canonical_url,
    shortlist.source::text AS source,
    shortlist.processing_state::text AS processing_state,
    shortlist.recommendation_outcome::text AS recommendation_outcome,
    canonical.rejection_reason
  FROM v_canonical_shortlist_actions_scoped AS shortlist
  JOIN canonical_jobs AS canonical
    ON canonical.workspace_id = shortlist.workspace_id
   AND canonical.id = shortlist.canonical_job_id
  WHERE shortlist.pipeline_display_category = 'TECHNICAL_ERROR'
),
task_issues AS (
  SELECT
    job.workspace_id,
    job.canonical_job_id,
    CASE
      WHEN task.status = 'DEAD_LETTER' THEN 'TASK_DEAD_LETTER'
      WHEN task.blocked_on = 'JOB_CONTENT' THEN 'DESCRIPTION_INCOMPLETE'
      ELSE 'BLOCKED_DEPENDENCY'
    END AS issue_class,
    task.id AS task_id,
    task.task_type,
    COALESCE(task.dead_letter_reason, task.blocked_reason, task.last_error) AS detail,
    task.repair_action,
    task.updated_at
  FROM error_jobs AS job
  JOIN pipeline_tasks AS task
    ON task.workspace_id = job.workspace_id
   AND task.status IN ('DEAD_LETTER', 'BLOCKED_DEPENDENCY')
   AND (
     task.payload->>'job_version_id' = job.job_version_id::text
     OR (
       NOT (task.payload ? 'job_version_id')
       AND task.payload->>'canonical_job_id' = job.canonical_job_id::text
     )
   )
  -- The same STALE_HISTORICAL rule as the technical-error count.
  WHERE NOT (
    task.status = 'DEAD_LETTER'
    AND task.task_type = 'PUBLISH_EMBEDDING'
    AND POSITION('RECONCILED_STALE_SUPERSEDED_JOB_VERSION' IN COALESCE(task.repair_action, '')) > 0
  )
),
evaluation_issues AS (
  SELECT
    job.workspace_id,
    job.canonical_job_id,
    'EVALUATION_FAILED'::text AS issue_class,
    NULL::uuid AS task_id,
    'AI_EVALUATION'::text AS task_type,
    current_error.last_error::text AS detail,
    NULL::text AS repair_action,
    current_error.updated_at
  FROM error_jobs AS job
  JOIN v_current_evaluation_errors AS current_error
    ON current_error.workspace_id = job.workspace_id
   AND current_error.canonical_job_id = job.canonical_job_id
   AND current_error.job_version_id = job.job_version_id
),
all_issues AS (
  SELECT * FROM task_issues
  UNION ALL
  SELECT * FROM evaluation_issues
),
grouped_issues AS (
  SELECT
    workspace_id,
    canonical_job_id,
    issue_class,
    ARRAY_AGG(task_id ORDER BY updated_at DESC, task_id) FILTER (WHERE task_id IS NOT NULL) AS task_ids,
    ARRAY_AGG(DISTINCT task_type) AS task_types,
    (ARRAY_AGG(detail ORDER BY updated_at DESC) FILTER (WHERE detail IS NOT NULL))[1] AS issue_detail,
    (ARRAY_AGG(repair_action ORDER BY updated_at DESC) FILTER (WHERE repair_action IS NOT NULL))[1] AS repair_action,
    MAX(updated_at) AS detected_at
  FROM all_issues
  GROUP BY workspace_id, canonical_job_id, issue_class
),
job_issues AS (
  SELECT
    job.*,
    grouped.issue_class,
    grouped.task_ids,
    grouped.task_types,
    grouped.issue_detail,
    grouped.repair_action,
    grouped.detected_at
  FROM error_jobs AS job
  JOIN grouped_issues AS grouped
    ON grouped.workspace_id = job.workspace_id
   AND grouped.canonical_job_id = job.canonical_job_id
  UNION ALL
  -- A job in PROCESSING_ERROR with no current task or evaluation issue still gets a row.
  SELECT
    job.*,
    'PROCESSING_ERROR'::text AS issue_class,
    NULL::uuid[] AS task_ids,
    NULL::text[] AS task_types,
    job.rejection_reason AS issue_detail,
    NULL::text AS repair_action,
    NULL::timestamptz AS detected_at
  FROM error_jobs AS job
  WHERE NOT EXISTS (
    SELECT 1 FROM grouped_issues AS grouped
    WHERE grouped.workspace_id = job.workspace_id
      AND grouped.canonical_job_id = job.canonical_job_id
  )
)
SELECT
  issue.workspace_id,
  issue.canonical_job_id,
  issue.job_version_id,
  issue.title,
  issue.company,
  issue.canonical_url,
  issue.source,
  issue.processing_state,
  issue.recommendation_outcome,
  issue.issue_class,
  issue.issue_detail,
  issue.repair_action,
  COALESCE(issue.task_ids, ARRAY[]::uuid[]) AS task_ids,
  COALESCE(issue.task_types, ARRAY[]::text[]) AS task_types,
  (issue.issue_class = 'TASK_DEAD_LETTER') AS retryable,
  fetchable.observation_id IS NOT NULL AS fetchable_source,
  CASE issue.issue_class
    WHEN 'DESCRIPTION_INCOMPLETE' THEN
      CASE WHEN fetchable.observation_id IS NOT NULL
        THEN ARRAY['FETCH_DESCRIPTION', 'PASTE_DESCRIPTION', 'DISMISS']
        ELSE ARRAY['PASTE_DESCRIPTION', 'DISMISS']
      END
    WHEN 'TASK_DEAD_LETTER' THEN ARRAY['RETRY', 'DISMISS']
    WHEN 'PROCESSING_ERROR' THEN ARRAY['PASTE_DESCRIPTION', 'DISMISS']
    ELSE ARRAY['DISMISS']
  END::text[] AS available_actions,
  issue.detected_at
FROM job_issues AS issue
LEFT JOIN LATERAL (
  -- The Gmail discovery card the pipeline's FETCH_JOB_CONTENT task can re-fetch.
  SELECT observation.id AS observation_id
  FROM raw_job_observations AS observation
  JOIN job_versions AS version
    ON version.workspace_id = observation.workspace_id
   AND version.id = observation.job_version_id
  WHERE observation.workspace_id = issue.workspace_id
    AND version.canonical_job_id = issue.canonical_job_id
    AND observation.source_name = 'GMAIL_ALERT'
    AND NULLIF(BTRIM(observation.source_url), '') IS NOT NULL
  LIMIT 1
) AS fetchable ON TRUE;

-- ============================================================================
-- 5) Audit ledger of support actions
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_support_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version TEXT NOT NULL DEFAULT 'job_support_action_v1'
    CHECK (schema_version = 'job_support_action_v1'),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE RESTRICT,
  job_version_id UUID REFERENCES job_versions(id) ON DELETE RESTRICT,
  issue_class TEXT NOT NULL CHECK (issue_class IN (
    'DESCRIPTION_INCOMPLETE', 'TASK_DEAD_LETTER', 'BLOCKED_DEPENDENCY',
    'EVALUATION_FAILED', 'PROCESSING_ERROR'
  )),
  action TEXT NOT NULL CHECK (action IN ('FETCH_DESCRIPTION', 'PASTE_DESCRIPTION', 'RETRY', 'DISMISS')),
  outcome TEXT NOT NULL CHECK (outcome IN ('APPLIED', 'NO_CHANGE')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  performed_by_user_id UUID NOT NULL REFERENCES workspace_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_support_actions_job
  ON job_support_actions (workspace_id, canonical_job_id, created_at DESC);

CREATE OR REPLACE FUNCTION job_support_actions_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'job_support_actions is append-only; record a new action instead.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_support_actions_append_only ON job_support_actions;
CREATE TRIGGER job_support_actions_append_only
  BEFORE UPDATE OR DELETE ON job_support_actions
  FOR EACH ROW EXECUTE FUNCTION job_support_actions_append_only();

DROP TRIGGER IF EXISTS job_support_actions_no_truncate ON job_support_actions;
CREATE TRIGGER job_support_actions_no_truncate
  BEFORE TRUNCATE ON job_support_actions
  FOR EACH STATEMENT EXECUTE FUNCTION job_support_actions_append_only();

COMMENT ON VIEW v_canonical_shortlist_actions_scoped IS
  'Current shortlist rows with user-action and technical-error projection. Technical errors exclude STALE_HISTORICAL embedding dead letters of superseded job versions (src/tasks/deadLetterPolicy.ts).';
COMMENT ON VIEW v_job_status_buckets_scoped IS
  'One row per current, non-archived, non-fixture job with exactly one status_bucket: REJECTED (hard gate), UNMATCHED (passed gates; no target lane or a mandatory qualification gap), REMOVED (manual), TECHNICAL_ERROR, APPLY_NOW, NEEDS_VERIFICATION, SKIP, REVIEW_AWAITING_AI, REVIEW_EVALUATED_NOT_READY, TRACK, PROCESSING.';
COMMENT ON VIEW v_job_status_bucket_counts_scoped IS
  'Per-workspace counts of v_job_status_buckets_scoped; the bucket counts sum to total_jobs.';
COMMENT ON VIEW v_application_workspace_summary_scoped IS
  'Authoritative, unpaginated workspace summary; pipeline metrics use current scoped read models and each active workspace member receives a user_id/user_key-scoped application count row. rejected_count + unmatched_count + removed_count = rejected_unmatched_count (kept for compatibility).';
COMMENT ON VIEW v_job_support_issues_scoped IS
  'One row per (TECHNICAL_ERROR job, issue class) with task ids, detail and the available_actions the support API accepts for that class.';
COMMENT ON TABLE job_support_actions IS
  'Append-only audit of dashboard support actions (fetch/paste description, retry, dismiss) on technical-error jobs.';
