-- Migration 060: Remove DEFERRED_BUDGET as an active canonical lifecycle state.
--
-- Budget deferrals remain preserved in evaluation_budget_deferrals as audit records,
-- but the canonical job remains in an artifact-supported business state.
-- No recommendation thresholds are changed.

UPDATE canonical_jobs
SET
  processing_state = CASE
    WHEN recommendation_outcome IS NOT NULL AND routing_disposition = 'ROUTED' THEN 'MATCHED'
    WHEN routing_disposition = 'ROUTED' AND primary_lane IS NOT NULL AND primary_lane <> 'UNCLASSIFIED' THEN 'LANE_ROUTED'
    WHEN routing_disposition = 'POLICY_NO_MATCH' THEN 'UNMATCHED'
    ELSE 'PREQUALIFIED'
  END,
  processing_status = CASE
    WHEN recommendation_outcome IS NOT NULL AND routing_disposition = 'ROUTED' THEN 'MATCHED'
    WHEN routing_disposition = 'ROUTED' AND primary_lane IS NOT NULL AND primary_lane <> 'UNCLASSIFIED' THEN 'LANE_ROUTED'
    WHEN routing_disposition = 'POLICY_NO_MATCH' THEN 'UNMATCHED'
    ELSE 'PREQUALIFIED'
  END,
  rejection_reason = CASE
    WHEN routing_disposition = 'ROUTED' THEN NULL
    WHEN routing_disposition = 'POLICY_NO_MATCH' THEN COALESCE(rejection_reason, 'NO_ACTIVE_LANE_MATCH')
    ELSE rejection_reason
  END,
  updated_at = NOW()
WHERE processing_state = 'DEFERRED_BUDGET'
   OR processing_status = 'DEFERRED_BUDGET';

COMMENT ON COLUMN canonical_jobs.processing_state IS
  'Current deterministic lifecycle state. DEFERRED_BUDGET is historical-only; budget deferrals are audited in evaluation_budget_deferrals and do not create a career-state pool.';
