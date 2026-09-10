-- Migration 043: workspace-scoped current read model for API and Streamlit
--
-- Consumers must not join canonical tables to scope a read model or infer
-- currentness from legacy fields. Keep the historical view intact and expose
-- one stable, workspace-scoped contract with explicit stale/blocked state.

CREATE OR REPLACE VIEW v_canonical_shortlist_scoped AS
SELECT
  c.workspace_id,
  s.*,
  CASE
    WHEN blocked.blocked_task_count > 0 THEN 'BLOCKED_DEPENDENCY'
    WHEN s.gate_status = 'PASS' AND (
      active_profile.id IS NULL
      OR target_jv.active_requirement_set_id IS NULL
      OR mr.id IS NULL
      OR mr.status <> 'COMPLETED'
      OR mr.canonical_job_id IS DISTINCT FROM c.id
      OR mr.job_version_id IS DISTINCT FROM target_jv.id
      OR mr.profile_version_id IS DISTINCT FROM active_profile.id
      OR mr.requirement_set_id IS DISTINCT FROM target_jv.active_requirement_set_id
      OR mr.job_content_hash IS DISTINCT FROM target_jv.content_hash
      OR mr.context_fingerprint IS NULL
    ) THEN 'MATCH_STALE'
    WHEN s.gate_status = 'PASS' AND (
      dd.id IS NULL
      OR dd.canonical_job_id IS DISTINCT FROM c.id
      OR dd.job_version_id IS DISTINCT FROM target_jv.id
      OR dd.match_run_id IS DISTINCT FROM mr.id
      OR dd.context_fingerprint IS NULL
    ) THEN 'DECISION_STALE'
    WHEN s.gate_status = 'PASS' AND latest_eval.id IS NULL THEN 'EVALUATION_MISSING'
    WHEN s.gate_status = 'PASS' AND (
      latest_eval.profile_version_id IS DISTINCT FROM active_profile.id
      OR latest_eval.canonical_job_id IS DISTINCT FROM c.id
      OR latest_eval.job_version_id IS DISTINCT FROM target_jv.id
      OR latest_eval.match_run_id IS DISTINCT FROM mr.id
      OR latest_eval.deterministic_decision_id IS DISTINCT FROM dd.id
      OR latest_eval.job_content_hash IS DISTINCT FROM target_jv.content_hash
      OR latest_eval.context_fingerprint IS NULL
    ) THEN 'EVALUATION_STALE'
    WHEN s.version_mismatch THEN 'EVALUATION_STALE'
    ELSE 'CURRENT_OR_NOT_APPLICABLE'
  END AS current_artifact_status,
  CASE
    WHEN blocked.blocked_task_count > 0 THEN blocked.blocked_reason
    WHEN s.gate_status = 'PASS' AND active_profile.id IS NULL THEN 'NO_ACTIVE_PROFILE'
    WHEN s.gate_status = 'PASS' AND target_jv.active_requirement_set_id IS NULL THEN 'NO_ACTIVE_REQUIREMENT_SET'
    WHEN s.gate_status = 'PASS' AND mr.id IS NULL THEN 'NO_CURRENT_MATCH_RUN'
    WHEN s.gate_status = 'PASS' AND mr.status <> 'COMPLETED' THEN 'MATCH_RUN_NOT_COMPLETED'
    WHEN s.gate_status = 'PASS' AND mr.canonical_job_id IS DISTINCT FROM c.id THEN 'MATCH_CANONICAL_JOB_STALE'
    WHEN s.gate_status = 'PASS' AND mr.job_version_id IS DISTINCT FROM target_jv.id THEN 'MATCH_JOB_VERSION_STALE'
    WHEN s.gate_status = 'PASS' AND mr.profile_version_id IS DISTINCT FROM active_profile.id THEN 'MATCH_PROFILE_VERSION_STALE'
    WHEN s.gate_status = 'PASS' AND mr.requirement_set_id IS DISTINCT FROM target_jv.active_requirement_set_id THEN 'MATCH_REQUIREMENT_SET_STALE'
    WHEN s.gate_status = 'PASS' AND mr.job_content_hash IS DISTINCT FROM target_jv.content_hash THEN 'MATCH_JOB_CONTENT_STALE'
    WHEN s.gate_status = 'PASS' AND mr.context_fingerprint IS NULL THEN 'MATCH_CONTEXT_UNPROVABLE'
    WHEN s.gate_status = 'PASS' AND dd.id IS NULL THEN 'NO_CURRENT_DETERMINISTIC_DECISION'
    WHEN s.gate_status = 'PASS' AND dd.canonical_job_id IS DISTINCT FROM c.id THEN 'DECISION_CANONICAL_JOB_STALE'
    WHEN s.gate_status = 'PASS' AND dd.job_version_id IS DISTINCT FROM target_jv.id THEN 'DECISION_JOB_VERSION_STALE'
    WHEN s.gate_status = 'PASS' AND dd.match_run_id IS DISTINCT FROM mr.id THEN 'DECISION_MATCH_RUN_STALE'
    WHEN s.gate_status = 'PASS' AND dd.context_fingerprint IS NULL THEN 'DECISION_CONTEXT_UNPROVABLE'
    WHEN s.gate_status = 'PASS' AND latest_eval.id IS NULL THEN 'NO_CURRENT_AI_EVALUATION'
    WHEN s.gate_status = 'PASS' AND latest_eval.context_fingerprint IS NULL THEN 'EVALUATION_CONTEXT_UNPROVABLE'
    WHEN s.version_mismatch THEN 'NO_CURRENT_EVALUATION_FOR_DISPLAYED_VERSION'
    ELSE NULL
  END AS current_artifact_reason,
  blocked.blocked_task_count
FROM canonical_jobs c
JOIN v_canonical_shortlist s
  ON s.canonical_job_id = c.id
LEFT JOIN LATERAL (
  SELECT jv.id, jv.active_requirement_set_id, jv.content_hash
  FROM job_versions jv
  WHERE jv.workspace_id = c.workspace_id
    AND jv.id = s.job_version_id::uuid
  LIMIT 1
) target_jv ON TRUE
LEFT JOIN LATERAL (
  SELECT pv.id
  FROM profile_versions pv
  WHERE pv.workspace_id = c.workspace_id
    AND pv.status = 'ACTIVE'
  ORDER BY pv.created_at DESC
  LIMIT 1
) active_profile ON TRUE
LEFT JOIN match_runs mr
  ON mr.workspace_id = c.workspace_id
 AND mr.id = c.latest_match_run_id
LEFT JOIN deterministic_decisions dd
  ON dd.workspace_id = c.workspace_id
 AND dd.id = c.latest_deterministic_decision_id
LEFT JOIN LATERAL (
  SELECT ae.id, ae.canonical_job_id, ae.job_version_id,
         ae.profile_version_id, ae.match_run_id,
         ae.deterministic_decision_id, ae.job_content_hash,
         ae.context_fingerprint
  FROM ai_evaluations ae
  WHERE ae.workspace_id = c.workspace_id
    AND ae.canonical_job_id = c.id
    AND ae.job_version_id = s.job_version_id::uuid
  ORDER BY ae.evaluated_at DESC, ae.id DESC
  LIMIT 1
) latest_eval ON TRUE
LEFT JOIN LATERAL (
  SELECT
    COUNT(*)::int AS blocked_task_count,
    MAX(pt.blocked_reason) AS blocked_reason
  FROM pipeline_tasks pt
  WHERE pt.workspace_id = c.workspace_id
    AND pt.status = 'BLOCKED_DEPENDENCY'
    AND (
      pt.payload->>'canonical_job_id' = c.id::text
      OR pt.payload->>'job_version_id' = s.job_version_id::text
    )
) blocked ON TRUE;

CREATE OR REPLACE VIEW v_rejected_jobs_audit_scoped AS
SELECT c.workspace_id, r.*
FROM canonical_jobs c
JOIN v_rejected_jobs_audit r ON r.id = c.id;

COMMENT ON VIEW v_canonical_shortlist_scoped IS
  'Stable workspace-scoped shortlist read model. Includes explicit current_artifact_status and current_artifact_reason.';
COMMENT ON VIEW v_rejected_jobs_audit_scoped IS
  'Stable workspace-scoped rejected-job audit read model.';
