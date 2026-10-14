-- Migration 063: Clear stale decisions from incomplete deterministic matches.
--
-- A LANE_ROUTED job with UNKNOWN profile evidence is still processing. A prior
-- TRACK/REVIEW outcome must not make it appear terminal or hide it from the
-- processing metric.

UPDATE canonical_jobs
SET recommendation_eligibility = NULL,
    recommendation_outcome = NULL,
    recommendation_requirement_score = NULL,
    recommendation_coverage_score = NULL,
    recommendation_evidence_completeness = NULL,
    recommendation_decided_at = NULL,
    updated_at = NOW()
WHERE COALESCE(processing_state, processing_status) = 'LANE_ROUTED'
  AND profile_match_status = 'UNKNOWN'
  AND recommendation_outcome IS NOT NULL;
