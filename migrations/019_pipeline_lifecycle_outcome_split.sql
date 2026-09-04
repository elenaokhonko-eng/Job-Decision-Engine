-- Migration 019: Pipeline lifecycle/outcome split (deterministic decisions, no budget deferral)
--
-- Goals:
-- 1) Add `processing_state` (lifecycle) and recommendation outcome columns on canonical_jobs.
-- 2) Backfill `processing_state` from legacy `processing_status`.
-- 3) Remove DEFERRED_BUDGET as an active state by backfilling to claimable lifecycle states.
-- 4) Materialize deterministic recommendation fields so UI/read models can display immediately.
-- 5) Extend the Streamlit read model to expose processing_state and recommendation fields.
--
-- Notes:
-- - This migration is additive and reversible (no drops of user data).
-- - Existing migrations 001–018 must not be edited (IDE closeout contract).

BEGIN;

-- 1) Add lifecycle + deterministic recommendation columns (additive)
ALTER TABLE canonical_jobs
  ADD COLUMN IF NOT EXISTS processing_state VARCHAR(50),
  ADD COLUMN IF NOT EXISTS recommendation_eligibility VARCHAR(20),
  ADD COLUMN IF NOT EXISTS recommendation_outcome VARCHAR(20),
  ADD COLUMN IF NOT EXISTS recommendation_requirement_score NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS recommendation_coverage_score NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS recommendation_evidence_completeness NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS recommendation_decided_at TIMESTAMPTZ;

-- 2) Backfill processing_state from legacy processing_status (never NULL)
UPDATE canonical_jobs
SET processing_state = COALESCE(processing_state, processing_status, 'RAW_STAGED')
WHERE processing_state IS NULL;

ALTER TABLE canonical_jobs
  ALTER COLUMN processing_state SET DEFAULT 'RAW_STAGED';

ALTER TABLE canonical_jobs
  ALTER COLUMN processing_state SET NOT NULL;

-- 3) Add lightweight validity checks (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'canonical_jobs'
      AND constraint_name = 'canonical_jobs_recommendation_eligibility_chk'
  ) THEN
    ALTER TABLE canonical_jobs
      ADD CONSTRAINT canonical_jobs_recommendation_eligibility_chk
      CHECK (
        recommendation_eligibility IS NULL
        OR recommendation_eligibility IN ('ELIGIBLE', 'VERIFY', 'INELIGIBLE')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'canonical_jobs'
      AND constraint_name = 'canonical_jobs_recommendation_outcome_chk'
  ) THEN
    ALTER TABLE canonical_jobs
      ADD CONSTRAINT canonical_jobs_recommendation_outcome_chk
      CHECK (
        recommendation_outcome IS NULL
        OR recommendation_outcome IN ('PRIORITY', 'REVIEW', 'TRACK', 'SKIP')
      );
  END IF;
END $$;

-- 4) Backfill DEFERRED_BUDGET rows to claimable lifecycle states (no longer terminal)
-- Prefer MATCHED when deterministic artifacts exist; otherwise fall back to LANE_ROUTED.
UPDATE canonical_jobs
SET processing_state = CASE
      WHEN deterministic_match_score IS NOT NULL OR latest_match_run_id IS NOT NULL THEN 'MATCHED'
      ELSE 'LANE_ROUTED'
    END,
    processing_status = CASE
      WHEN processing_status = 'DEFERRED_BUDGET' THEN
        CASE
          WHEN deterministic_match_score IS NOT NULL OR latest_match_run_id IS NOT NULL THEN 'MATCHED'
          ELSE 'LANE_ROUTED'
        END
      ELSE processing_status
    END,
    updated_at = NOW()
WHERE processing_state = 'DEFERRED_BUDGET'
   OR processing_status = 'DEFERRED_BUDGET';

-- 5) Materialize deterministic recommendation fields for existing rows
-- (Outcome is independent of LLM evaluation; it uses gate decision + deterministic matching + evidence completeness.)
WITH computed AS (
  SELECT
    c.id AS canonical_job_id,
    CASE
      WHEN c.gate_decision = 'PASS' THEN 'ELIGIBLE'
      WHEN c.gate_decision = 'NEEDS_VERIFICATION' THEN 'VERIFY'
      WHEN c.gate_decision = 'HARD_REJECT' THEN 'INELIGIBLE'
      ELSE 'VERIFY'
    END AS eligibility,
    CASE WHEN c.deterministic_match_score IS NULL THEN NULL ELSE (c.deterministic_match_score / 100.0) END AS requirement_score,
    CASE WHEN c.deterministic_match_coverage IS NULL THEN NULL ELSE (c.deterministic_match_coverage / 100.0) END AS coverage_score,
    (
      (
        CASE WHEN COALESCE(c.workplace_type, 'UNKNOWN') IN ('REMOTE', 'HYBRID', 'ONSITE') THEN 1 ELSE 0 END
        + CASE
            WHEN COALESCE(c.workplace_type, 'UNKNOWN') = 'REMOTE'
              OR (COALESCE(c.workability_facts, '{}'::jsonb)->>'office_days_max') IS NOT NULL
            THEN 1 ELSE 0
          END
        + CASE
            WHEN (COALESCE(c.workability_facts, '{}'::jsonb)->>'employment_type') IN ('PERMANENT', 'CONTRACT')
            THEN 1 ELSE 0
          END
        + CASE
            WHEN (COALESCE(c.workability_facts, '{}'::jsonb)->>'travel_pct_max') IS NOT NULL
            THEN 1 ELSE 0
          END
      ) / 4.0
    )::numeric(4,3) AS evidence_completeness
  FROM canonical_jobs c
  WHERE COALESCE(c.processing_state, c.processing_status) <> 'MANUALLY_REMOVED'
)
UPDATE canonical_jobs c
SET recommendation_eligibility = computed.eligibility,
    recommendation_requirement_score = computed.requirement_score,
    recommendation_coverage_score = computed.coverage_score,
    recommendation_evidence_completeness = computed.evidence_completeness,
    recommendation_outcome = CASE
      WHEN computed.eligibility = 'INELIGIBLE' THEN 'SKIP'
      WHEN computed.requirement_score IS NULL OR computed.coverage_score IS NULL THEN
        CASE WHEN computed.eligibility = 'VERIFY' THEN 'REVIEW' ELSE 'TRACK' END
      WHEN computed.eligibility = 'ELIGIBLE'
        AND computed.requirement_score >= 0.75
        AND computed.coverage_score >= 0.55
        AND computed.evidence_completeness >= 0.70
        THEN 'PRIORITY'
      WHEN computed.requirement_score >= 0.50 THEN 'REVIEW'
      ELSE 'TRACK'
    END,
    recommendation_decided_at = COALESCE(c.recommendation_decided_at, NOW())
FROM computed
WHERE c.id = computed.canonical_job_id;

-- 6) Update read models to expose lifecycle + deterministic outcome
DROP VIEW IF EXISTS shortlist_view CASCADE;
DROP VIEW IF EXISTS v_canonical_shortlist CASCADE;
DROP VIEW IF EXISTS v_rejected_jobs_audit CASCADE;

CREATE OR REPLACE VIEW v_canonical_shortlist AS
WITH target_versions AS (
  SELECT
    c.id AS canonical_job_id,
    COALESCE(c.latest_job_version_id, lv.id) AS version_id,
    COALESCE(jv_direct.description_text, lv.description_text) AS description_text,
    COALESCE(jv_direct.observed_at, lv.observed_at, c.created_at) AS observed_at
  FROM canonical_jobs c
  LEFT JOIN job_versions jv_direct ON jv_direct.id = c.latest_job_version_id
  LEFT JOIN LATERAL (
    SELECT id, description_text, observed_at
    FROM job_versions
    WHERE canonical_job_id = c.id
    ORDER BY observed_at DESC
    LIMIT 1
  ) lv ON TRUE
),
latest_observations AS (
  SELECT DISTINCT ON (rjo.job_version_id)
    rjo.job_version_id,
    rjo.source_name,
    rjo.retrieved_at
  FROM raw_job_observations rjo
  WHERE rjo.job_version_id IS NOT NULL
  ORDER BY rjo.job_version_id, rjo.retrieved_at DESC
),
version_gates AS (
  SELECT DISTINCT ON (canonical_job_id, job_version_id)
    canonical_job_id,
    job_version_id,
    decision AS gate_status,
    rejection_codes,
    evidence_quotes,
    gate_version,
    created_at
  FROM gate_decisions
  ORDER BY canonical_job_id, job_version_id, created_at DESC
),
version_evaluations AS (
  SELECT DISTINCT ON (canonical_job_id, job_version_id)
    id AS eval_id,
    canonical_job_id,
    job_version_id,
    full_evaluation_payload,
    lane_matches,
    workability_facts,
    provider AS eval_provider,
    model AS eval_model,
    attempt AS eval_attempt,
    is_fallback AS eval_is_fallback,
    degraded_state AS eval_degraded,
    evaluated_at
  FROM ai_evaluations
  ORDER BY canonical_job_id, job_version_id, evaluated_at DESC
),
version_queue AS (
  SELECT DISTINCT ON (canonical_job_id, job_version_id)
    canonical_job_id,
    job_version_id,
    status AS queue_status,
    priority_score,
    attempt_count,
    last_error,
    available_at,
    enqueued_at,
    updated_at
  FROM evaluation_queue
  ORDER BY canonical_job_id, job_version_id, COALESCE(updated_at, enqueued_at, available_at, NOW()) DESC
),
latest_cv_documents AS (
  SELECT DISTINCT ON (dr.canonical_job_id, dr.job_version_id)
    dr.canonical_job_id,
    dr.job_version_id,
    dr.id AS cv_document_run_id
  FROM document_runs dr
  WHERE dr.document_type = 'CV' AND dr.status = 'COMPLETED'
  ORDER BY dr.canonical_job_id, dr.job_version_id, dr.completed_at DESC NULLS LAST, dr.created_at DESC
),
latest_cover_letters AS (
  SELECT DISTINCT ON (dr.canonical_job_id, dr.job_version_id)
    dr.canonical_job_id,
    dr.job_version_id,
    dr.id AS cover_letter_document_run_id
  FROM document_runs dr
  WHERE dr.document_type = 'COVER_LETTER' AND dr.status = 'COMPLETED'
  ORDER BY dr.canonical_job_id, dr.job_version_id, dr.completed_at DESC NULLS LAST, dr.created_at DESC
)
SELECT
  c.id AS canonical_job_id,
  tv.version_id AS job_version_id,
  COALESCE(c.normalized_title, 'Unknown Title') AS title,
  COALESCE(c.company_name, 'Unknown Company') AS company,
  c.canonical_url,
  COALESCE(lo.source_name, 'UNKNOWN') AS source,
  COALESCE(c.location, c.location_summary, 'Unknown') AS location,
  COALESCE(c.workplace_type, 'UNKNOWN') AS workplace_type,
  COALESCE(c.employment_type, 'UNKNOWN') AS employment_type,
  tv.description_text AS description,
  COALESCE(vg.gate_status, 'NEEDS_VERIFICATION') AS gate_status,
  vg.rejection_codes,
  vg.evidence_quotes AS gate_evidence_quotes,
  c.primary_lane,
  c.secondary_lanes,
  c.lane_confidence,
  COALESCE(vq.priority_score, 0.0) AS priority_score,
  c.deterministic_match_score,
  c.deterministic_match_coverage,
  COALESCE(c.processing_state, c.processing_status) AS processing_state,
  COALESCE(c.processing_state, c.processing_status) AS processing_status,
  c.recommendation_eligibility,
  c.recommendation_outcome,
  c.recommendation_requirement_score,
  c.recommendation_coverage_score,
  c.recommendation_evidence_completeness,
  c.recommendation_decided_at,
  (ve.full_evaluation_payload->>'nd_friendly_score')::numeric AS nd_friendly_score,
  (ve.full_evaluation_payload->>'politics_stress_score')::numeric AS politics_stress_score,
  (ve.full_evaluation_payload->>'sensory_overload_index')::numeric AS sensory_overload_index,
  ve.full_evaluation_payload->>'next_action' AS next_action,
  ve.full_evaluation_payload->>'strategic_value' AS strategic_value,
  ve.full_evaluation_payload->>'recommended_cv_version' AS recommended_cv_version,
  ve.full_evaluation_payload->>'evaluation_summary' AS evaluation_summary,
  ve.eval_provider,
  ve.eval_is_fallback,
  (ve.eval_id IS NULL AND COALESCE(c.processing_state, c.processing_status) = 'AI_EVALUATED') AS version_mismatch,
  tv.observed_at,
  ve.evaluated_at,
  ve.lane_matches,
  ve.workability_facts,
  vq.queue_status,
  c.latest_match_run_id,
  cv.cv_document_run_id,
  cl.cover_letter_document_run_id,
  ((cv.cv_document_run_id IS NOT NULL) OR (cl.cover_letter_document_run_id IS NOT NULL)) AS document_ready
FROM canonical_jobs c
JOIN target_versions tv ON tv.canonical_job_id = c.id
LEFT JOIN latest_observations lo ON lo.job_version_id = tv.version_id
LEFT JOIN version_gates vg ON vg.canonical_job_id = c.id AND vg.job_version_id = tv.version_id
LEFT JOIN version_evaluations ve ON ve.canonical_job_id = c.id AND ve.job_version_id = tv.version_id
LEFT JOIN version_queue vq ON vq.canonical_job_id = c.id AND vq.job_version_id = tv.version_id
LEFT JOIN latest_cv_documents cv ON cv.canonical_job_id = c.id AND cv.job_version_id = tv.version_id
LEFT JOIN latest_cover_letters cl ON cl.canonical_job_id = c.id AND cl.job_version_id = tv.version_id
WHERE COALESCE(c.processing_state, c.processing_status) NOT IN ('HARD_REJECTED', 'MANUALLY_REMOVED');

CREATE OR REPLACE VIEW v_rejected_jobs_audit AS
WITH target_versions AS (
  SELECT
    c.id AS canonical_job_id,
    COALESCE(c.latest_job_version_id, lv.id) AS version_id,
    COALESCE(jv_direct.description_text, lv.description_text) AS description_text,
    COALESCE(jv_direct.observed_at, lv.observed_at, c.created_at) AS observed_at
  FROM canonical_jobs c
  LEFT JOIN job_versions jv_direct ON jv_direct.id = c.latest_job_version_id
  LEFT JOIN LATERAL (
    SELECT id, description_text, observed_at
    FROM job_versions
    WHERE canonical_job_id = c.id
    ORDER BY observed_at DESC
    LIMIT 1
  ) lv ON TRUE
),
latest_observations AS (
  SELECT DISTINCT ON (rjo.job_version_id)
    rjo.job_version_id,
    rjo.source_name,
    rjo.retrieved_at
  FROM raw_job_observations rjo
  WHERE rjo.job_version_id IS NOT NULL
  ORDER BY rjo.job_version_id, rjo.retrieved_at DESC
),
version_gates AS (
  SELECT DISTINCT ON (canonical_job_id, job_version_id)
    canonical_job_id,
    job_version_id,
    decision AS gate_status,
    rejection_codes,
    evidence_quotes,
    created_at
  FROM gate_decisions
  ORDER BY canonical_job_id, job_version_id, created_at DESC
),
version_evaluations AS (
  SELECT DISTINCT ON (canonical_job_id, job_version_id)
    canonical_job_id,
    job_version_id,
    full_evaluation_payload,
    evaluated_at
  FROM ai_evaluations
  ORDER BY canonical_job_id, job_version_id, evaluated_at DESC
)
SELECT
  c.id,
  tv.version_id AS job_version_id,
  COALESCE(c.normalized_title, 'Unknown Title') AS title,
  COALESCE(c.company_name, 'Unknown Company') AS company,
  c.canonical_url AS careers_portal_url,
  COALESCE(lo.source_name, 'UNKNOWN') AS source,
  COALESCE(c.processing_state, c.processing_status) AS status,
  c.rejection_reason,
  COALESCE(vg.gate_status, 'NEEDS_VERIFICATION') AS gate_status,
  vg.rejection_codes,
  vg.evidence_quotes AS gate_evidence_quotes,
  tv.description_text AS description,
  (ve.full_evaluation_payload->>'nd_friendly_score')::numeric AS nd_friendly_score,
  (ve.full_evaluation_payload->>'politics_stress_score')::numeric AS politics_stress_score,
  (ve.full_evaluation_payload->>'sensory_overload_index')::numeric AS sensory_overload_index,
  tv.observed_at::text AS "postedDate"
FROM canonical_jobs c
JOIN target_versions tv ON tv.canonical_job_id = c.id
LEFT JOIN latest_observations lo ON lo.job_version_id = tv.version_id
LEFT JOIN version_gates vg ON vg.canonical_job_id = c.id AND vg.job_version_id = tv.version_id
LEFT JOIN version_evaluations ve ON ve.canonical_job_id = c.id AND ve.job_version_id = tv.version_id
WHERE COALESCE(c.processing_state, c.processing_status) IN ('HARD_REJECTED', 'MANUALLY_REMOVED');

CREATE OR REPLACE VIEW shortlist_view AS
SELECT * FROM v_canonical_shortlist;

COMMIT;

