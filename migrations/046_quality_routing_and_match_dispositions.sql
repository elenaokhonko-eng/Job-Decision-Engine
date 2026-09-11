-- Migration 046: explicit data-quality, routing, and profile-match dispositions
--
-- These are additive classifications. They do not replace the lifecycle state:
-- ROUTING_DEFERRED remains a lifecycle holding state for compatibility, while
-- routing_disposition explains whether it is retryable technical work or a
-- successful policy no-match. Likewise MATCHED means the comparison stage ran;
-- profile_match_status says whether it found grounded evidence.

ALTER TABLE canonical_jobs
  ADD COLUMN IF NOT EXISTS description_quality_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS description_quality_reason TEXT,
  ADD COLUMN IF NOT EXISTS routing_disposition VARCHAR(32),
  ADD COLUMN IF NOT EXISTS profile_match_status VARCHAR(32);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'canonical_jobs'::regclass
      AND conname = 'canonical_jobs_description_quality_status_chk'
  ) THEN
    ALTER TABLE canonical_jobs
      ADD CONSTRAINT canonical_jobs_description_quality_status_chk
      CHECK (
        description_quality_status IS NULL
        OR description_quality_status IN ('COMPLETE', 'INCOMPLETE', 'UNKNOWN')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'canonical_jobs'::regclass
      AND conname = 'canonical_jobs_routing_disposition_chk'
  ) THEN
    ALTER TABLE canonical_jobs
      ADD CONSTRAINT canonical_jobs_routing_disposition_chk
      CHECK (
        routing_disposition IS NULL
        OR routing_disposition IN ('ROUTED', 'POLICY_NO_MATCH', 'TECHNICAL_DEFERRED')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'canonical_jobs'::regclass
      AND conname = 'canonical_jobs_profile_match_status_chk'
  ) THEN
    ALTER TABLE canonical_jobs
      ADD CONSTRAINT canonical_jobs_profile_match_status_chk
      CHECK (
        profile_match_status IS NULL
        OR profile_match_status IN ('POSITIVE_MATCH', 'NO_PROFILE_MATCH', 'UNKNOWN')
      );
  END IF;
END $$;

-- Backfill source quality from the latest canonical version. 1000 characters
-- is the configured completeness floor; this is a data-quality flag, not a
-- career rejection and does not discard the short observation.
UPDATE canonical_jobs c
SET description_quality_status = CASE
      WHEN NULLIF(BTRIM(jv.description_text), '') IS NULL THEN 'UNKNOWN'
      WHEN length(BTRIM(jv.description_text)) >= 1000 THEN 'COMPLETE'
      ELSE 'INCOMPLETE'
    END,
    description_quality_reason = CASE
      WHEN NULLIF(BTRIM(jv.description_text), '') IS NULL THEN 'DESCRIPTION_MISSING'
      WHEN length(BTRIM(jv.description_text)) >= 1000 THEN NULL
      ELSE 'DESCRIPTION_BELOW_1000_CHAR_COMPLETENESS_FLOOR'
    END
FROM job_versions jv
WHERE jv.workspace_id = c.workspace_id
  AND jv.id = c.latest_job_version_id;

UPDATE canonical_jobs c
SET routing_disposition = CASE
      WHEN COALESCE(c.primary_lane, 'UNCLASSIFIED') <> 'UNCLASSIFIED' THEN 'ROUTED'
      WHEN COALESCE(c.lane_evidence, '') ILIKE '%ROUTING_POLICY_NO_MATCH%' THEN 'POLICY_NO_MATCH'
      WHEN COALESCE(c.lane_evidence, '') ILIKE '%EMBEDDING%'
        OR COALESCE(c.lane_evidence, '') ILIKE '%ROUTING_ERROR%'
        OR COALESCE(c.lane_evidence, '') ILIKE '%ZERO_VECTOR%'
        THEN 'TECHNICAL_DEFERRED'
      ELSE routing_disposition
    END
WHERE c.latest_lane_decision_id IS NOT NULL
   OR c.primary_lane IS NOT NULL
   OR c.lane_evidence IS NOT NULL;

UPDATE canonical_jobs c
SET profile_match_status = CASE
      WHEN mr.status = 'COMPLETED' AND COALESCE(mr.matched_count, 0) > 0 THEN 'POSITIVE_MATCH'
      WHEN mr.status = 'COMPLETED' THEN 'NO_PROFILE_MATCH'
      ELSE 'UNKNOWN'
    END
FROM match_runs mr
WHERE mr.workspace_id = c.workspace_id
  AND mr.id = c.latest_match_run_id;

CREATE INDEX IF NOT EXISTS idx_canonical_jobs_routing_disposition
  ON canonical_jobs(workspace_id, routing_disposition, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_jobs_profile_match_status
  ON canonical_jobs(workspace_id, profile_match_status, updated_at DESC);

COMMENT ON COLUMN canonical_jobs.description_quality_status IS
  'Source completeness classification; INCOMPLETE is enrichment debt, never a career rejection.';
COMMENT ON COLUMN canonical_jobs.routing_disposition IS
  'ROUTED, successful POLICY_NO_MATCH, or retryable TECHNICAL_DEFERRED explanation for ROUTING_DEFERRED lifecycle state.';
COMMENT ON COLUMN canonical_jobs.profile_match_status IS
  'Positive grounded profile evidence, completed comparison with no positive evidence, or unknown/incomplete comparison.';
