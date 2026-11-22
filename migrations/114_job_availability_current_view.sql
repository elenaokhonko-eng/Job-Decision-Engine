-- Migration 114: one read-model field that says whether a posting is currently open.
--
-- Until now the "open and not out of date" rule lived only in recommendationDecider.ts, and every
-- Streamlit list that wanted it had to recompute it or ignore it. This view states the same rule
-- once, in SQL, on top of v_application_readiness_current (which already resolves the latest source
-- evidence against job_versions). src/decision/availability.ts is the TypeScript statement of the
-- rule; src/tests/decision/availabilityParity.integration.test.ts fails if the two ever differ.
--
--   CLOSED  : availability_status = 'CLOSED', or the authoritative source expiry date has passed.
--   OPEN    : status OPEN, verified, and availability_recheck_at is in the future.
--   UNKNOWN : everything else (including OPEN whose window has run out). Never turned into CLOSED.
--
-- Additive only: a new view, no table or existing view is changed.
--
-- Rollback: DROP VIEW IF EXISTS v_job_availability_current;

CREATE OR REPLACE VIEW v_job_availability_current AS
SELECT
  readiness.workspace_id,
  readiness.canonical_job_id,
  readiness.job_version_id,
  readiness.availability_status,
  readiness.availability_verified_at,
  readiness.availability_recheck_at,
  readiness.source_expires_at,
  CASE
    WHEN readiness.availability_status = 'CLOSED'
      OR (readiness.source_expires_at IS NOT NULL AND readiness.source_expires_at <= NOW()) THEN 'CLOSED'
    WHEN readiness.availability_status = 'OPEN'
      AND readiness.availability_verified_at IS NOT NULL
      AND readiness.availability_recheck_at IS NOT NULL
      AND readiness.availability_recheck_at > NOW() THEN 'OPEN'
    ELSE 'UNKNOWN'
  END AS availability_state,
  COALESCE(
    readiness.availability_status = 'OPEN'
    AND readiness.availability_verified_at IS NOT NULL
    AND readiness.availability_recheck_at IS NOT NULL
    AND readiness.availability_recheck_at > NOW()
    AND NOT (readiness.source_expires_at IS NOT NULL AND readiness.source_expires_at <= NOW()),
    FALSE
  ) AS availability_current
FROM v_application_readiness_current AS readiness;

COMMENT ON VIEW v_job_availability_current IS
  'One row per current job version with availability_state (OPEN / CLOSED / UNKNOWN) and availability_current (true only for OPEN). The single read-model statement of the rule in src/decision/availability.ts; every list that must hide unconfirmed postings reads this view.';
