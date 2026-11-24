-- Migration 121: one stored ranking score per job, with the role-shape evidence next to it.
--
-- Contract: canonical_jobs.recommendation_requirement_score is the ADJUSTED score (the raw match score lowered by
-- the role-shape downranks, written by src/pipeline/recommendationDecider.ts). Every list (Review, Priority, Top 10,
-- the review-sheet script) must order by that one stored value. v_job_ranking_scoped names it ranking_score and
-- keeps the raw score beside it as raw_match_score for display only; no list may order by raw_match_score.
--
-- New canonical_jobs columns, all written by the decider in the same update as the score:
--   recommendation_score_policy         the policy behind the stored score: '<match_runs.policy_version>|<role-shape policy>'.
--                                       Scores with different values are on different scales (must-be-zero check in the reconciler).
--   recommendation_degree_asked_for     the posting's own words when a MUST degree is flagged, else NULL.
--   recommendation_role_signals         JSON array of {code, penalty, source, quote}, [] when none.
--   recommendation_evidence_confidence  NORMAL or LOW (thin posting); NULL until the decider has run.
-- Existing rows keep NULL / [] until the decider re-decides them (its context fingerprint changed in #239, so the next
-- run re-decides every job once).
--
-- Additive: four nullable-or-defaulted columns and one new view. Nothing is rewritten or deleted.
--
-- Rollback (exact; src/tests/ingestion/rankingReadModel.integration.test.ts runs it):
--   DROP VIEW IF EXISTS v_job_ranking_scoped;
--   ALTER TABLE canonical_jobs
--     DROP COLUMN IF EXISTS recommendation_evidence_confidence,
--     DROP COLUMN IF EXISTS recommendation_role_signals,
--     DROP COLUMN IF EXISTS recommendation_degree_asked_for,
--     DROP COLUMN IF EXISTS recommendation_score_policy;

ALTER TABLE canonical_jobs
  ADD COLUMN IF NOT EXISTS recommendation_score_policy TEXT,
  ADD COLUMN IF NOT EXISTS recommendation_degree_asked_for TEXT,
  ADD COLUMN IF NOT EXISTS recommendation_role_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS recommendation_evidence_confidence TEXT;

ALTER TABLE canonical_jobs
  DROP CONSTRAINT IF EXISTS canonical_jobs_recommendation_evidence_confidence_check;
ALTER TABLE canonical_jobs
  ADD CONSTRAINT canonical_jobs_recommendation_evidence_confidence_check
  CHECK (recommendation_evidence_confidence IS NULL OR recommendation_evidence_confidence IN ('NORMAL', 'LOW'));

CREATE OR REPLACE VIEW v_job_ranking_scoped AS
SELECT
  job.workspace_id,
  job.id AS canonical_job_id,
  job.latest_job_version_id AS job_version_id,
  job.recommendation_outcome,
  job.recommendation_eligibility,
  job.recommendation_requirement_score AS ranking_score,
  job.deterministic_match_score AS raw_match_score,
  job.recommendation_score_policy AS score_policy,
  job.recommendation_degree_asked_for AS degree_asked_for,
  job.recommendation_role_signals AS role_signals,
  job.recommendation_evidence_confidence AS evidence_confidence
FROM canonical_jobs job
WHERE job.archived_at IS NULL
  AND job.is_test_fixture IS NOT TRUE;

COMMENT ON VIEW v_job_ranking_scoped IS
  'One row per live job: ranking_score is the stored ADJUSTED score every list orders by; raw_match_score is for display only.';
