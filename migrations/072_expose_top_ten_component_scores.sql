-- Migration 072: expose persisted score components used by the Top 10 UI.
--
-- The public view keeps its existing columns and appends immutable lineage and
-- component scores from the exact ranking snapshot.

CREATE OR REPLACE VIEW v_top_ten_ready_jobs_scoped AS
WITH current_rankings AS (
  SELECT
    shortlist.*,
    ranking.id AS ranking_snapshot_id,
    ranking.ranking_policy_version,
    ranking.context_fingerprint AS ranking_context_fingerprint,
    ranking.overall_rank_score,
    ranking.ranking_confidence,
    ranking.is_top_ten_ready,
    ranking.policy_recheck_required,
    ROW_NUMBER() OVER (
      PARTITION BY shortlist.workspace_id
      ORDER BY ranking.overall_rank_score DESC,
               ranking.ranking_confidence DESC,
               ranking.computed_at DESC,
               ranking.id
    ) AS ranking_position,
    active_profile.id AS profile_version_id,
    match_run.id AS match_run_id,
    decision.id AS deterministic_decision_id,
    ai_evaluation.id AS ai_evaluation_id,
    ranking.requirement_fit_score,
    ranking.requirement_coverage_score,
    ranking.evidence_completeness_score,
    ranking.lane_confidence_score,
    ranking.autonomy_score,
    ranking.politics_risk_score,
    ranking.sensory_workload_risk_score,
    ranking.strategic_value_score,
    ranking.focus_protection_score,
    ranking.building_ratio_score,
    ranking.interaction_burden_score
  FROM v_canonical_shortlist_scoped AS shortlist
  JOIN canonical_jobs AS job
    ON job.id = shortlist.canonical_job_id
   AND job.workspace_id = shortlist.workspace_id
  JOIN job_versions AS job_version
    ON job_version.id = shortlist.job_version_id::UUID
   AND job_version.workspace_id = job.workspace_id
   AND job_version.canonical_job_id = job.id
   AND job.latest_job_version_id = job_version.id
  JOIN LATERAL (
    SELECT profile.id
    FROM profile_versions AS profile
    WHERE profile.workspace_id = job.workspace_id
      AND profile.status = 'ACTIVE'
    ORDER BY profile.created_at DESC, profile.id DESC
    LIMIT 1
  ) AS active_profile ON TRUE
  JOIN match_runs AS match_run
    ON match_run.workspace_id = job.workspace_id
   AND match_run.id = job.latest_match_run_id
   AND match_run.canonical_job_id = job.id
   AND match_run.job_version_id = job_version.id
   AND match_run.profile_version_id = active_profile.id
   AND match_run.status = 'COMPLETED'
   AND job_version.active_requirement_set_id IS NOT NULL
   AND match_run.requirement_set_id = job_version.active_requirement_set_id
   AND match_run.job_content_hash = job_version.content_hash
   AND match_run.context_fingerprint IS NOT NULL
  JOIN deterministic_decisions AS decision
    ON decision.workspace_id = job.workspace_id
   AND decision.id = job.latest_deterministic_decision_id
   AND decision.canonical_job_id = job.id
   AND decision.job_version_id = job_version.id
   AND decision.match_run_id = match_run.id
   AND decision.context_fingerprint IS NOT NULL
  JOIN LATERAL (
    SELECT evaluation.*
    FROM ai_evaluations AS evaluation
    WHERE evaluation.workspace_id = job.workspace_id
      AND evaluation.canonical_job_id = job.id
      AND evaluation.job_version_id = job_version.id
      AND evaluation.profile_version_id = active_profile.id
      AND evaluation.match_run_id = match_run.id
      AND evaluation.deterministic_decision_id = decision.id
      AND evaluation.job_content_hash = job_version.content_hash
      AND evaluation.context_fingerprint = decision.context_fingerprint
    ORDER BY evaluation.evaluated_at DESC, evaluation.id DESC
    LIMIT 1
  ) AS ai_evaluation ON TRUE
  JOIN LATERAL (
    SELECT policy.policy_version, policy.minimum_ranking_confidence
    FROM ranking_policies AS policy
    WHERE policy.workspace_id = job.workspace_id
    ORDER BY policy.policy_version DESC
    LIMIT 1
  ) AS current_policy ON TRUE
  JOIN job_ranking_snapshots AS ranking
    ON ranking.workspace_id = job.workspace_id
   AND ranking.canonical_job_id = job.id
   AND ranking.job_version_id = job_version.id
   AND ranking.profile_version_id = active_profile.id
   AND ranking.match_run_id = match_run.id
   AND ranking.deterministic_decision_id = decision.id
   AND ranking.ai_evaluation_id = ai_evaluation.id
   AND ranking.ranking_policy_version = current_policy.policy_version
   AND ranking.context_fingerprint = ai_evaluation.context_fingerprint
  WHERE shortlist.gate_status = 'PASS'
    AND shortlist.current_artifact_status = 'CURRENT_OR_NOT_APPLICABLE'
    AND shortlist.version_mismatch = FALSE
    AND shortlist.primary_lane IS NOT NULL
    AND BTRIM(shortlist.primary_lane) <> ''
    AND job_version.content_hash = match_run.job_content_hash
    AND decision.recommendation_eligibility = shortlist.recommendation_eligibility
    AND decision.recommendation_outcome = shortlist.recommendation_outcome
    AND shortlist.recommendation_eligibility = 'ELIGIBLE'
    AND shortlist.recommendation_outcome IN ('PRIORITY', 'REVIEW')
    AND decision.recommendation_eligibility = 'ELIGIBLE'
    AND decision.recommendation_outcome IN ('PRIORITY', 'REVIEW')
    AND ai_evaluation.context_fingerprint IS NOT NULL
    AND ranking.requirement_fit_score IS NOT NULL
    AND ranking.requirement_coverage_score IS NOT NULL
    AND ranking.evidence_completeness_score IS NOT NULL
    AND ranking.lane_confidence_score IS NOT NULL
    AND ranking.is_top_ten_ready = TRUE
    AND ranking.policy_recheck_required = FALSE
    AND NOT EXISTS (
      SELECT 1
      FROM policy_recheck_requests AS pending_recheck
      WHERE pending_recheck.workspace_id = job.workspace_id
        AND pending_recheck.canonical_job_id = job.id
        AND pending_recheck.job_version_id = job_version.id
        AND pending_recheck.ai_evaluation_id = ai_evaluation.id
        AND pending_recheck.context_fingerprint = decision.context_fingerprint
        AND pending_recheck.status = 'PENDING'
    )
    AND ranking.ranking_confidence >= current_policy.minimum_ranking_confidence
)
SELECT current_rankings.*
FROM current_rankings
WHERE current_rankings.ranking_position <= 10;

COMMENT ON VIEW v_top_ten_ready_jobs_scoped IS
  'Current Top 10 ranking rows with complete artifact lineage and persisted ranking components from the exact snapshot.';
