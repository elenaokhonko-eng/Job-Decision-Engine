-- Migration 062: Remove stale no-match reasons from successfully routed jobs.
--
-- Older lane-router runs preserved NO_ACTIVE_LANE_MATCH when a later replay
-- successfully routed the job. Keep rejection reasons only for policy no-match
-- outcomes so routed jobs cannot present contradictory business state.

UPDATE canonical_jobs
SET rejection_reason = NULL,
    updated_at = NOW()
WHERE routing_disposition = 'ROUTED'
  AND rejection_reason = 'NO_ACTIVE_LANE_MATCH';
