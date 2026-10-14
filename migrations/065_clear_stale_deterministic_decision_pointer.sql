-- Migration 065: Clear stale deterministic-decision pointers on incomplete matches.
--
-- The match artifact remains current, but an UNKNOWN profile match has no
-- current deterministic recommendation decision. Preserve the decision row as
-- history while removing the canonical pointer used by current read models.

UPDATE canonical_jobs
SET latest_deterministic_decision_id = NULL,
    updated_at = NOW()
WHERE COALESCE(processing_state, processing_status) = 'LANE_ROUTED'
  AND profile_match_status = 'UNKNOWN'
  AND recommendation_outcome IS NULL
  AND latest_deterministic_decision_id IS NOT NULL;
