-- Migration 069: require complete current match context before documents are READY.
--
-- A document is current only when its pinned match, profile, decision, requirement
-- set, and content hash still agree with the canonical job and active profile.

CREATE OR REPLACE VIEW v_application_workspace_scoped AS
SELECT
  application.id AS application_record_id,
  application.workspace_id,
  application.user_id,
  application.canonical_job_id,
  application.job_version_id,
  application.status AS application_status,
  application.submission_url,
  application.cv_document_run_id,
  application.cover_letter_document_run_id,
  application.notes,
  application.handoff_payload,
  application.target_submit_at,
  application.submitted_at,
  application.follow_up_at,
  application.last_action_at,
  application.created_at,
  application.updated_at,
  job.normalized_title AS title,
  job.company_name AS company,
  job.canonical_url,
  COALESCE(job.processing_state, job.processing_status) AS processing_state,
  job.recommendation_eligibility,
  job.recommendation_outcome,
  job.primary_lane,
  job.secondary_lanes,
  (job.latest_job_version_id = application.job_version_id) AS is_current_job_version,
  CASE
    WHEN application.cv_document_run_id IS NULL THEN 'NOT_GENERATED'
    WHEN cv_document.id IS NOT NULL
     AND job.latest_job_version_id = application.job_version_id
     AND job.latest_match_run_id = current_match.id
     AND job.latest_deterministic_decision_id = current_decision.id
     AND active_profile.id = cv_document.profile_version_id
     AND current_match.id = cv_document.match_run_id
     AND current_decision.id = cv_document.deterministic_decision_id
     AND current_decision.context_fingerprint = cv_document.context_fingerprint
     AND current_match.context_fingerprint = cv_document.context_fingerprint
     AND current_decision.context_fingerprint = current_match.context_fingerprint
     AND job_version.active_requirement_set_id IS NOT NULL
     AND current_match.requirement_set_id = job_version.active_requirement_set_id
     AND job_version.content_hash IS NOT NULL
     AND current_match.job_content_hash = job_version.content_hash
     AND current_shortlist.gate_status = 'PASS'
     AND current_shortlist.recommendation_eligibility = 'ELIGIBLE'
     AND current_shortlist.recommendation_outcome IN ('PRIORITY', 'REVIEW')
     AND current_decision.recommendation_eligibility = 'ELIGIBLE'
     AND current_decision.recommendation_outcome IN ('PRIORITY', 'REVIEW')
     AND cv_document.status = 'COMPLETED' THEN 'READY'
    ELSE 'STALE'
  END AS cv_document_status,
  CASE
    WHEN application.cover_letter_document_run_id IS NULL THEN 'NOT_GENERATED'
    WHEN cover_letter_document.id IS NOT NULL
     AND job.latest_job_version_id = application.job_version_id
     AND job.latest_match_run_id = current_match.id
     AND job.latest_deterministic_decision_id = current_decision.id
     AND active_profile.id = cover_letter_document.profile_version_id
     AND current_match.id = cover_letter_document.match_run_id
     AND current_decision.id = cover_letter_document.deterministic_decision_id
     AND current_decision.context_fingerprint = cover_letter_document.context_fingerprint
     AND current_match.context_fingerprint = cover_letter_document.context_fingerprint
     AND current_decision.context_fingerprint = current_match.context_fingerprint
     AND job_version.active_requirement_set_id IS NOT NULL
     AND current_match.requirement_set_id = job_version.active_requirement_set_id
     AND job_version.content_hash IS NOT NULL
     AND current_match.job_content_hash = job_version.content_hash
     AND current_shortlist.gate_status = 'PASS'
     AND current_shortlist.recommendation_eligibility = 'ELIGIBLE'
     AND current_shortlist.recommendation_outcome IN ('PRIORITY', 'REVIEW')
     AND current_decision.recommendation_eligibility = 'ELIGIBLE'
     AND current_decision.recommendation_outcome IN ('PRIORITY', 'REVIEW')
     AND cover_letter_document.status = 'COMPLETED' THEN 'READY'
    ELSE 'STALE'
  END AS cover_letter_document_status
FROM application_records AS application
JOIN canonical_jobs AS job
  ON job.workspace_id = application.workspace_id
 AND job.id = application.canonical_job_id
JOIN job_versions AS job_version
  ON job_version.workspace_id = application.workspace_id
 AND job_version.canonical_job_id = application.canonical_job_id
 AND job_version.id = application.job_version_id
LEFT JOIN v_canonical_shortlist_scoped AS current_shortlist
  ON current_shortlist.workspace_id = job.workspace_id
 AND current_shortlist.canonical_job_id = job.id
 AND current_shortlist.job_version_id = job.latest_job_version_id
LEFT JOIN LATERAL (
  SELECT profile.id
  FROM profile_versions AS profile
  WHERE profile.workspace_id = job.workspace_id
    AND profile.status = 'ACTIVE'
  ORDER BY profile.created_at DESC, profile.id DESC
  LIMIT 1
) AS active_profile ON TRUE
LEFT JOIN match_runs AS current_match
  ON current_match.workspace_id = job.workspace_id
 AND current_match.id = job.latest_match_run_id
 AND current_match.canonical_job_id = job.id
 AND current_match.job_version_id = job.latest_job_version_id
 AND current_match.profile_version_id = active_profile.id
 AND current_match.status = 'COMPLETED'
LEFT JOIN deterministic_decisions AS current_decision
  ON current_decision.workspace_id = job.workspace_id
 AND current_decision.id = job.latest_deterministic_decision_id
 AND current_decision.canonical_job_id = job.id
 AND current_decision.job_version_id = job.latest_job_version_id
 AND current_decision.match_run_id = current_match.id
LEFT JOIN document_runs AS cv_document
  ON cv_document.workspace_id = application.workspace_id
 AND cv_document.id = application.cv_document_run_id
 AND cv_document.canonical_job_id = application.canonical_job_id
 AND cv_document.job_version_id = application.job_version_id
 AND cv_document.document_type = 'CV'
LEFT JOIN document_runs AS cover_letter_document
  ON cover_letter_document.workspace_id = application.workspace_id
 AND cover_letter_document.id = application.cover_letter_document_run_id
 AND cover_letter_document.canonical_job_id = application.canonical_job_id
 AND cover_letter_document.job_version_id = application.job_version_id
 AND cover_letter_document.document_type = 'COVER_LETTER';

COMMENT ON VIEW v_application_workspace_scoped IS
  'Workspace-scoped application tracker with document readiness pinned to current profile, match, requirement set, content hash, decision, and context fingerprint.';
