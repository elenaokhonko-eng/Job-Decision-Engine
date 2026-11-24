-- Migration 122: composite rank uses deterministic terms only; AI terms become display-only labels.
--
-- Product decision (option b): autonomy, politics risk and sensory workload risk (and the culture
-- priority fit derived from the same AI culture evidence) no longer move the sort. They stay stored
-- on every snapshot and are shown as labels with the AI's quote. The always-empty strategic value
-- term leaves the formula. A job without a current AI evaluation can now be ranked and is flagged
-- "AI notes pending" instead of being hidden.
--
-- New composite: requirementFit 37.5, requirementCoverage 15, evidenceCompleteness 10,
-- laneConfidence 10 (total 72.5, weighted average over the available terms). All other policy
-- weights are stored as 0 (all eight keys stay present); the materializer rejects a policy that gives
-- an AI term a positive weight. ranking_policies_weights_chk required a total of exactly 100, so this
-- migration relaxes it to "100, or all four AI weights 0 and the deterministic weights above 0".
--
-- What this migration does (additive; no data is updated or deleted):
--   1. job_ranking_snapshots.ai_evaluation_id becomes nullable (NULL = ranked without a current AI
--      evaluation). Duplicate prevention for the NULL case: job_ranking_snapshots_context_key is
--      already UNIQUE NULLS NOT DISTINCT over (workspace, job, job version, profile, match run,
--      decision, ai_evaluation_id, ranking_policy_version, preference_context_id,
--      context_fingerprint) since migration 075, so two NULL-evaluation snapshots for the same
--      context collide exactly like two snapshots with the same evaluation id. The migration
--      asserts that and fails loudly if the key has another shape.
--   2. Appends ranking_policies version = latest + 1 for every workspace (never UPDATE; rows are
--      immutable) and updates the workspace seed function to the same weights. Snapshots are keyed by
--      policy version and the read models join the latest policy version, so every eligible job is
--      re-materialised by the next materializer run. Until it runs the Top 10 is empty by design
--      (snapshots made with the old composite are not shown); the run needs no AI call.
--   3. CREATE OR REPLACE v_apply_now_jobs_scoped (same columns): the snapshot join no longer
--      requires an AI evaluation.
--   4. CREATE OR REPLACE v_top_ten_ready_jobs_scoped (same columns, same order): LEFT JOIN of the AI
--      evaluation, and EVALUATION_MISSING / EVALUATION_STALE jobs are admitted like in Apply Now.
--      ai_evaluation_id is NULL for a job without a current evaluation. is_top_ten_ready is kept.
--   5. CREATE OR REPLACE both Stage 3 views, appending display-only columns at the end:
--      ai_notes_pending, ai_label_autonomy_score, ai_label_politics_risk_score,
--      ai_label_sensory_workload_risk_score, ai_label_focus_protection_score,
--      ai_label_culture_priority_score, ai_label_evidence (the AI culture evidence with its quote).
--
-- Rollback (no data changes needed; policy rows are immutable and stay as history):
--   a. Re-run the CREATE OR REPLACE VIEW statements of v_apply_now_jobs_scoped and
--      v_top_ten_ready_jobs_scoped from migrations/078_evidence_readiness_discovery.sql, of
--      v_apply_now_jobs_stage3_scoped from migrations/104_apply_now_career_track.sql and of
--      v_top_ten_ready_jobs_stage3_scoped from
--      migrations/075_user_preference_lineage_freshness_company_policy.sql. The appended Stage 3
--      columns can only be removed with DROP VIEW and re-creation.
--   b. Append a ranking_policies row (latest + 1) copying the migration 076 weights, then restore the
--      migration 066 ranking_policies_weights_chk (total exactly 100). That needs the migration 122 policy
--      rows (total 72.5) out of the way, and policy rows are immutable, so restoring the strict check
--      needs human approval (use ADD CONSTRAINT ... NOT VALID to keep the history rows).
--   c. Only when no snapshot has a NULL ai_evaluation_id:
--        ALTER TABLE job_ranking_snapshots ALTER COLUMN ai_evaluation_id SET NOT NULL;

DO $$
DECLARE
  context_key_definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(constraint_row.oid)
  INTO context_key_definition
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'job_ranking_snapshots'::regclass
    AND constraint_row.conname = 'job_ranking_snapshots_context_key'
    AND constraint_row.contype = 'u';

  IF context_key_definition IS NULL
     OR POSITION('NULLS NOT DISTINCT' IN UPPER(context_key_definition)) = 0
     OR POSITION('ai_evaluation_id' IN context_key_definition) = 0 THEN
    RAISE EXCEPTION 'job_ranking_snapshots_context_key must be UNIQUE NULLS NOT DISTINCT over ai_evaluation_id before it can become nullable';
  END IF;
END
$$;

ALTER TABLE job_ranking_snapshots
  ALTER COLUMN ai_evaluation_id DROP NOT NULL;

COMMENT ON COLUMN job_ranking_snapshots.ai_evaluation_id IS
  'AI evaluation whose display-only labels this snapshot carries; NULL when the job was ranked without a current AI evaluation (AI notes pending).';

-- ranking_policies_weights_chk (migration 066) requires the eight weights to total exactly 100. The
-- deterministic composite totals 72.5 with the four AI terms at 0, so the total rule is relaxed to
-- "100, or the four AI terms are all 0 and the deterministic terms total more than 0". Every existing row
-- satisfies the old rule and therefore the new one; the key set and non-negativity rules are unchanged.
ALTER TABLE ranking_policies DROP CONSTRAINT ranking_policies_weights_chk;
ALTER TABLE ranking_policies ADD CONSTRAINT ranking_policies_weights_chk CHECK (
  jsonb_typeof(weights) = 'object'
  AND (weights - ARRAY[
    'requirementFit', 'requirementCoverage', 'evidenceCompleteness', 'laneConfidence',
    'autonomy', 'politicsRisk', 'sensoryWorkloadRisk', 'strategicValue'
  ]::TEXT[]) = '{}'::JSONB
  AND weights ?& ARRAY[
    'requirementFit', 'requirementCoverage', 'evidenceCompleteness', 'laneConfidence',
    'autonomy', 'politicsRisk', 'sensoryWorkloadRisk', 'strategicValue'
  ]::TEXT[]
  AND jsonb_typeof(weights -> 'requirementFit') = 'number'
  AND jsonb_typeof(weights -> 'requirementCoverage') = 'number'
  AND jsonb_typeof(weights -> 'evidenceCompleteness') = 'number'
  AND jsonb_typeof(weights -> 'laneConfidence') = 'number'
  AND jsonb_typeof(weights -> 'autonomy') = 'number'
  AND jsonb_typeof(weights -> 'politicsRisk') = 'number'
  AND jsonb_typeof(weights -> 'sensoryWorkloadRisk') = 'number'
  AND jsonb_typeof(weights -> 'strategicValue') = 'number'
  AND (weights ->> 'requirementFit')::NUMERIC >= 0
  AND (weights ->> 'requirementCoverage')::NUMERIC >= 0
  AND (weights ->> 'evidenceCompleteness')::NUMERIC >= 0
  AND (weights ->> 'laneConfidence')::NUMERIC >= 0
  AND (weights ->> 'autonomy')::NUMERIC >= 0
  AND (weights ->> 'politicsRisk')::NUMERIC >= 0
  AND (weights ->> 'sensoryWorkloadRisk')::NUMERIC >= 0
  AND (weights ->> 'strategicValue')::NUMERIC >= 0
  AND (
    (
      (weights ->> 'requirementFit')::NUMERIC
      + (weights ->> 'requirementCoverage')::NUMERIC
      + (weights ->> 'evidenceCompleteness')::NUMERIC
      + (weights ->> 'laneConfidence')::NUMERIC
      + (weights ->> 'autonomy')::NUMERIC
      + (weights ->> 'politicsRisk')::NUMERIC
      + (weights ->> 'sensoryWorkloadRisk')::NUMERIC
      + (weights ->> 'strategicValue')::NUMERIC
    ) = 100
    OR (
      (weights ->> 'autonomy')::NUMERIC = 0
      AND (weights ->> 'politicsRisk')::NUMERIC = 0
      AND (weights ->> 'sensoryWorkloadRisk')::NUMERIC = 0
      AND (weights ->> 'strategicValue')::NUMERIC = 0
      AND (
        (weights ->> 'requirementFit')::NUMERIC
        + (weights ->> 'requirementCoverage')::NUMERIC
        + (weights ->> 'evidenceCompleteness')::NUMERIC
        + (weights ->> 'laneConfidence')::NUMERIC
      ) > 0
    )
  )
);

CREATE OR REPLACE FUNCTION seed_default_ranking_policy_for_workspace()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO ranking_policies (
    workspace_id,
    policy_version,
    schema_version,
    weights,
    minimum_ranking_confidence
  ) VALUES (
    NEW.id,
    1,
    '5.5.0',
    '{
      "requirementFit": 37.5,
      "requirementCoverage": 15,
      "evidenceCompleteness": 10,
      "laneConfidence": 10,
      "autonomy": 0,
      "politicsRisk": 0,
      "sensoryWorkloadRisk": 0,
      "strategicValue": 0
    }'::JSONB,
    90.00
  )
  ON CONFLICT (workspace_id, policy_version) DO NOTHING;
  RETURN NEW;
END;
$$;

INSERT INTO ranking_policies (
  workspace_id,
  policy_version,
  schema_version,
  weights,
  minimum_ranking_confidence
)
SELECT
  latest_policy.workspace_id,
  latest_policy.policy_version + 1,
  '5.5.0',
  '{
    "requirementFit": 37.5,
    "requirementCoverage": 15,
    "evidenceCompleteness": 10,
    "laneConfidence": 10,
    "autonomy": 0,
    "politicsRisk": 0,
    "sensoryWorkloadRisk": 0,
    "strategicValue": 0
  }'::JSONB,
  latest_policy.minimum_ranking_confidence
FROM (
  SELECT DISTINCT ON (policy.workspace_id)
    policy.workspace_id,
    policy.policy_version,
    policy.weights,
    policy.minimum_ranking_confidence
  FROM ranking_policies AS policy
  ORDER BY policy.workspace_id, policy.policy_version DESC
) AS latest_policy
WHERE latest_policy.weights IS DISTINCT FROM '{
    "requirementFit": 37.5,
    "requirementCoverage": 15,
    "evidenceCompleteness": 10,
    "laneConfidence": 10,
    "autonomy": 0,
    "politicsRisk": 0,
    "sensoryWorkloadRisk": 0,
    "strategicValue": 0
  }'::JSONB
ON CONFLICT (workspace_id, policy_version) DO NOTHING;

CREATE OR REPLACE VIEW v_apply_now_jobs_scoped AS
WITH current_decisions AS (
  SELECT
    shortlist.*,
    ranking.overall_rank_score,
    ranking.ranking_confidence,
    ranking.id AS ranking_snapshot_id,
    EXISTS (
      SELECT 1
      FROM policy_recheck_requests AS recheck
      JOIN ai_evaluations AS recheck_evaluation
        ON recheck_evaluation.id = recheck.ai_evaluation_id
       AND recheck_evaluation.workspace_id = job.workspace_id
       AND recheck_evaluation.canonical_job_id = job.id
       AND recheck_evaluation.job_version_id = job_version.id
       AND recheck_evaluation.profile_version_id = active_profile.id
       AND recheck_evaluation.match_run_id = match_run.id
       AND recheck_evaluation.deterministic_decision_id = decision.id
       AND recheck_evaluation.job_content_hash = job_version.content_hash
       AND recheck_evaluation.context_fingerprint = decision.context_fingerprint
      WHERE recheck.workspace_id = job.workspace_id
        AND recheck.canonical_job_id = job.id
        AND recheck.job_version_id = job_version.id
        AND recheck.context_fingerprint = decision.context_fingerprint
        AND recheck.status = 'PENDING'
    ) AS policy_recheck_required
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
   AND decision.recommendation_eligibility = shortlist.recommendation_eligibility
   AND decision.recommendation_outcome = shortlist.recommendation_outcome
  LEFT JOIN LATERAL (
    SELECT snapshot.id, snapshot.overall_rank_score, snapshot.ranking_confidence
    FROM job_ranking_snapshots AS snapshot
    WHERE snapshot.workspace_id = job.workspace_id
      AND snapshot.canonical_job_id = job.id
      AND snapshot.job_version_id = job_version.id
      AND snapshot.profile_version_id = active_profile.id
      AND snapshot.match_run_id = match_run.id
      AND snapshot.deterministic_decision_id = decision.id
      AND snapshot.context_fingerprint = decision.context_fingerprint
      AND snapshot.ranking_policy_version = (
        SELECT MAX(current_policy.policy_version)
        FROM ranking_policies AS current_policy
        WHERE current_policy.workspace_id = job.workspace_id
      )
      AND (
        snapshot.ai_evaluation_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM ai_evaluations AS evaluation
          WHERE evaluation.id = snapshot.ai_evaluation_id
            AND evaluation.workspace_id = job.workspace_id
            AND evaluation.canonical_job_id = job.id
            AND evaluation.job_version_id = job_version.id
            AND evaluation.profile_version_id = active_profile.id
            AND evaluation.match_run_id = match_run.id
            AND evaluation.deterministic_decision_id = decision.id
            AND evaluation.job_content_hash = job_version.content_hash
            AND evaluation.context_fingerprint = decision.context_fingerprint
        )
      )
    -- A snapshot that carries a current AI evaluation wins over one without; both show the same
    -- composite because the AI terms are display-only.
    ORDER BY (snapshot.ai_evaluation_id IS NOT NULL) DESC, snapshot.computed_at DESC, snapshot.id
    LIMIT 1
  ) AS ranking ON TRUE
  WHERE shortlist.gate_status = 'PASS'
    AND shortlist.current_artifact_status IN (
      'CURRENT_OR_NOT_APPLICABLE',
      'EVALUATION_MISSING',
      'EVALUATION_STALE'
    )
)
SELECT current_decisions.*
FROM current_decisions
WHERE current_decisions.recommendation_eligibility = 'ELIGIBLE'
  AND current_decisions.recommendation_outcome IN ('PRIORITY', 'REVIEW')
  AND EXISTS (
    SELECT 1
    FROM v_application_readiness_current readiness
    WHERE readiness.workspace_id = current_decisions.workspace_id
      AND readiness.canonical_job_id = current_decisions.canonical_job_id
      AND readiness.job_version_id::text = current_decisions.job_version_id::text
      AND readiness.readiness_status = 'READY'
      AND readiness.readiness_fingerprint IS NOT NULL
  );

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
  LEFT JOIN LATERAL (
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
   AND ranking.ai_evaluation_id IS NOT DISTINCT FROM ai_evaluation.id
   AND ranking.ranking_policy_version = current_policy.policy_version
   AND ranking.context_fingerprint = decision.context_fingerprint
  WHERE shortlist.gate_status = 'PASS'
    AND shortlist.current_artifact_status IN (
      'CURRENT_OR_NOT_APPLICABLE',
      'EVALUATION_MISSING',
      'EVALUATION_STALE'
    )
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
    AND EXISTS (
      SELECT 1
      FROM v_application_readiness_current readiness
      WHERE readiness.workspace_id = job.workspace_id
        AND readiness.canonical_job_id = job.id
        AND readiness.job_version_id = job_version.id
        AND readiness.readiness_status = 'READY'
        AND readiness.readiness_fingerprint = decision.readiness_fingerprint
    )
)
SELECT current_rankings.*
FROM current_rankings
WHERE current_rankings.ranking_position <= 10;

-- Stage 3 read models: append display-only AI labels. Existing columns keep name, type and order.
CREATE OR REPLACE VIEW v_apply_now_jobs_stage3_scoped AS
SELECT
  apply_now.*,
  ranking.base_rank_score,
  ranking.freshness_score,
  ranking.remote_freedom_score,
  ranking.final_application_priority_score,
  ranking.remote_from_home_base_score,
  ranking.temporary_abroad_score,
  ranking.country_flexibility_score,
  ranking.office_requirement_score,
  ranking.timezone_compatibility_score,
  ranking.employment_verifiability_score,
  ranking.preference_context_id AS stage3_preference_context_id,
  ranking.component_availability AS ranking_component_availability,
  ranking.component_provenance AS ranking_component_provenance,
  decision.decision_json -> 'trace' -> 'career_track' ->> 'track' AS career_track,
  decision.decision_json -> 'trace' -> 'career_track' ->> 'level' AS career_track_level,
  COALESCE(decision.decision_json -> 'trace' -> 'career_track' -> 'tags', '[]'::jsonb) AS career_track_tags,
  decision.decision_json -> 'trace' -> 'career_track' ->> 'rationale' AS career_track_rationale,
  (ranking.ai_evaluation_id IS NULL) AS ai_notes_pending,
  ranking.autonomy_score AS ai_label_autonomy_score,
  ranking.politics_risk_score AS ai_label_politics_risk_score,
  ranking.sensory_workload_risk_score AS ai_label_sensory_workload_risk_score,
  ranking.focus_protection_score AS ai_label_focus_protection_score,
  ranking.culture_priority_score AS ai_label_culture_priority_score,
  COALESCE(ranking.component_provenance -> 'culture_evidence', '[]'::jsonb) AS ai_label_evidence
FROM v_apply_now_jobs_scoped AS apply_now
LEFT JOIN job_ranking_snapshots AS ranking
  ON ranking.id = apply_now.ranking_snapshot_id
 AND ranking.workspace_id = apply_now.workspace_id
 AND ranking.canonical_job_id = apply_now.canonical_job_id
 AND ranking.job_version_id = apply_now.job_version_id::UUID
LEFT JOIN canonical_jobs AS job
  ON job.id = apply_now.canonical_job_id
 AND job.workspace_id = apply_now.workspace_id
LEFT JOIN deterministic_decisions AS decision
  ON decision.id = job.latest_deterministic_decision_id
 AND decision.workspace_id = job.workspace_id
 AND decision.canonical_job_id = job.id;

CREATE OR REPLACE VIEW v_top_ten_ready_jobs_stage3_scoped AS
SELECT
  top_ten.*,
  ranking.base_rank_score,
  ranking.freshness_score,
  ranking.remote_freedom_score,
  ranking.final_application_priority_score,
  ranking.remote_from_home_base_score,
  ranking.temporary_abroad_score,
  ranking.country_flexibility_score,
  ranking.office_requirement_score,
  ranking.timezone_compatibility_score,
  ranking.employment_verifiability_score,
  ranking.preference_context_id AS stage3_preference_context_id,
  ranking.component_availability AS ranking_component_availability,
  ranking.component_provenance AS ranking_component_provenance,
  (ranking.ai_evaluation_id IS NULL) AS ai_notes_pending,
  ranking.autonomy_score AS ai_label_autonomy_score,
  ranking.politics_risk_score AS ai_label_politics_risk_score,
  ranking.sensory_workload_risk_score AS ai_label_sensory_workload_risk_score,
  ranking.focus_protection_score AS ai_label_focus_protection_score,
  ranking.culture_priority_score AS ai_label_culture_priority_score,
  COALESCE(ranking.component_provenance -> 'culture_evidence', '[]'::jsonb) AS ai_label_evidence
FROM v_top_ten_ready_jobs_scoped AS top_ten
JOIN job_ranking_snapshots AS ranking
  ON ranking.id = top_ten.ranking_snapshot_id
 AND ranking.workspace_id = top_ten.workspace_id
 AND ranking.canonical_job_id = top_ten.canonical_job_id
 AND ranking.job_version_id = top_ten.job_version_id::UUID;

COMMENT ON VIEW v_apply_now_jobs_scoped IS
  'Apply Now rows require a current READY readiness assessment. The ranking snapshot no longer requires an AI evaluation (migration 122).';
COMMENT ON VIEW v_top_ten_ready_jobs_scoped IS
  'Top Ten rows require a current READY readiness assessment matching the latest deterministic decision. A current AI evaluation is not required; ai_evaluation_id is NULL while AI notes are pending (migration 122).';
COMMENT ON VIEW v_apply_now_jobs_stage3_scoped IS
  'Apply Now rows with Stage 3 ranking components, preference lineage, track-aware seniority and display-only AI labels (ai_label_*, ai_notes_pending) that do not enter the rank.';
COMMENT ON VIEW v_top_ten_ready_jobs_stage3_scoped IS
  'Top 10 rows with Stage 3 ranking components, preference lineage and display-only AI labels (ai_label_*, ai_notes_pending) that do not enter the rank.';
