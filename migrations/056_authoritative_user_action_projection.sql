-- Migration 056: Authoritative user-action projection.
--
-- Pipeline state and career recommendation are distinct. A job is surfaced for
-- human action only through a current, immutable verification-question link.
-- Technical task failures remain support-visible but never imply career REVIEW.

CREATE TABLE IF NOT EXISTS verification_question_job_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  verification_question_id UUID NOT NULL REFERENCES verification_questions(id) ON DELETE CASCADE,
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
  job_version_id UUID NOT NULL REFERENCES job_versions(id) ON DELETE CASCADE,
  gate_decision_id UUID REFERENCES gate_decisions(id) ON DELETE SET NULL,
  profile_version_id UUID REFERENCES profile_versions(id) ON DELETE SET NULL,
  preference_mode_id UUID REFERENCES workspace_user_preference_modes(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'OBSOLETE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (workspace_id, verification_question_id, canonical_job_id, job_version_id)
);

CREATE INDEX IF NOT EXISTS idx_verification_question_job_links_current
  ON verification_question_job_links (workspace_id, canonical_job_id, job_version_id, status)
  WHERE status = 'OPEN';

CREATE OR REPLACE VIEW v_current_user_actions AS
WITH latest_gates AS (
  SELECT DISTINCT ON (gd.workspace_id, gd.canonical_job_id, gd.job_version_id)
    gd.id,
    gd.workspace_id,
    gd.canonical_job_id,
    gd.job_version_id,
    gd.decision,
    gd.created_at
  FROM gate_decisions gd
  ORDER BY gd.workspace_id, gd.canonical_job_id, gd.job_version_id, gd.created_at DESC, gd.id DESC
),
active_profiles AS (
  SELECT DISTINCT ON (workspace_id)
    workspace_id,
    id
  FROM profile_versions
  WHERE status = 'ACTIVE'
  ORDER BY workspace_id, created_at DESC, id DESC
)
SELECT DISTINCT ON (link.workspace_id, link.canonical_job_id, link.job_version_id)
  link.workspace_id,
  link.canonical_job_id,
  link.job_version_id,
  link.verification_question_id,
  'VERIFICATION_QUESTION'::text AS action_type,
  question.category AS action_category,
  'OPEN'::text AS action_status
FROM verification_question_job_links link
JOIN verification_questions question
  ON question.id = link.verification_question_id
 AND question.workspace_id = link.workspace_id
JOIN canonical_jobs job
  ON job.id = link.canonical_job_id
 AND job.workspace_id = link.workspace_id
JOIN latest_gates gate
  ON gate.id = link.gate_decision_id
 AND gate.workspace_id = link.workspace_id
 AND gate.canonical_job_id = link.canonical_job_id
 AND gate.job_version_id = link.job_version_id
LEFT JOIN active_profiles profile
  ON profile.workspace_id = link.workspace_id
WHERE link.status = 'OPEN'
  AND question.status = 'PENDING'
  AND COALESCE(job.processing_state, job.processing_status) = 'NEEDS_VERIFICATION'
  AND job.latest_job_version_id = link.job_version_id
  AND gate.decision = 'NEEDS_VERIFICATION'
  AND (link.profile_version_id IS NULL OR link.profile_version_id = profile.id)
  AND (
    link.preference_mode_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM workspace_user_preference_modes mode
      WHERE mode.id = link.preference_mode_id
        AND mode.workspace_id = link.workspace_id
        AND mode.is_active = TRUE
    )
  )
ORDER BY link.workspace_id, link.canonical_job_id, link.job_version_id, question.updated_at DESC, link.created_at DESC;

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
    WHEN shortlist.processing_state IN (
      'RAW_STAGED', 'PREQUALIFIED', 'ROUTING_DEFERRED', 'LANE_ROUTED',
      'QUEUED_FOR_AI', 'EVALUATING', 'AI_EVALUATED', 'EVALUATED', 'RETRY_WAIT',
      'NEEDS_VERIFICATION'
    ) OR shortlist.current_artifact_status <> 'CURRENT_OR_NOT_APPLICABLE'
      THEN 'PROCESSING_AUTOMATICALLY'
    WHEN shortlist.processing_state IN ('HARD_REJECTED', 'UNMATCHED')
      THEN 'REJECTED_UNMATCHED'
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

COMMENT ON VIEW v_current_user_actions IS
  'Current immutable user-action artifacts only; stale gates and pipeline retries never appear here.';
COMMENT ON VIEW v_canonical_shortlist_actions_scoped IS
  'Canonical shortlist with authoritative user-action and pipeline-display projections.';
