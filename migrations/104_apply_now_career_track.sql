-- Migration 104: expose the track-aware seniority result in Apply Now.
--
-- The recommendation decider records a career_track assessment in
-- deterministic_decisions.decision_json -> trace -> career_track (track, level, fit, tags such as
-- TRANSITION / STRETCH / STEP_DOWN / BRIDGE, and the rationale). Apply Now shows it so the user
-- can see why a role was kept or held below PRIORITY.
--
-- This replaces only the outer Stage 3 Apply Now view and appends four columns at the end, so the
-- existing column list, order and types are unchanged. The decision joined here is the job's
-- latest deterministic decision, the same row v_apply_now_jobs_scoped already requires.
-- Rows decided before this change have no career_track; the columns are then NULL.
--
-- Rollback (restores the migration 075 definition; no data changes):
--   DROP VIEW IF EXISTS v_apply_now_jobs_stage3_scoped;
--   then re-run the CREATE VIEW v_apply_now_jobs_stage3_scoped statement and its COMMENT from
--   migrations/075_user_preference_lineage_freshness_company_policy.sql.

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
  decision.decision_json -> 'trace' -> 'career_track' ->> 'rationale' AS career_track_rationale
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

COMMENT ON VIEW v_apply_now_jobs_stage3_scoped IS
  'Apply Now rows with the matching current Stage 3 ranking snapshot components, preference lineage, and the track-aware seniority result (career_track, level, tags, rationale).';
