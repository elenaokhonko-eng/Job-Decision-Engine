-- Migration 110: employer-confirmed job facts recorded by the user, and a per-job verification
-- read model.
--
-- Many saved jobs stay at NEEDS_VERIFICATION because the posting never states a workability fact
-- the gate needs (work mode, office days, travel, on-call, employment type, location). The
-- workspace-wide verification answers (config 'verification_answers') are personal caps; by design
-- they cannot fill a fact the posting never states. job_confirmed_facts holds what the user learned
-- from the employer for one exact job version: the fact, its value, where it came from (recruiter
-- email or call, careers page, hiring manager, other), an optional note or URL, who recorded it and
-- when. The hard gate and the readiness assessment read the current fact for the job version and use
-- it only where the posting itself leaves the fact unknown (src/pipeline/confirmedJobFacts.ts).
--
-- Rows are append-only. Correcting a fact adds a row whose supersedes_fact_id names the fact it
-- replaces; each fact can be superseded once and each (job version, fact type) chain has one root,
-- so exactly one current fact exists per chain. Nothing is updated or deleted.
--
-- v_job_confirmed_facts_current lists the current (unsuperseded) fact per job version and type.
-- v_job_verification_checks_scoped gives Streamlit one row per current job version with the gate's
-- stored workability facts, the facts that are still open, and the confirmed facts, so the app does
-- not join raw tables.
--
-- Rollback: DROP VIEW v_job_verification_checks_scoped; DROP VIEW v_job_confirmed_facts_current;
-- then, only with explicit human approval because it removes user-recorded evidence,
-- DROP TABLE job_confirmed_facts and the functions job_confirmed_facts_validate and
-- job_confirmed_facts_append_only. Gate and readiness code treats a missing current fact as
-- "no confirmation", so dropping the views alone stops new confirmations being applied.

CREATE TABLE IF NOT EXISTS job_confirmed_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version TEXT NOT NULL DEFAULT 'job_confirmed_fact_v1'
    CHECK (schema_version = 'job_confirmed_fact_v1'),
  workspace_id UUID NOT NULL,
  canonical_job_id UUID NOT NULL,
  job_version_id UUID NOT NULL,
  fact_type TEXT NOT NULL CHECK (fact_type IN (
    'WORK_MODE', 'OFFICE_DAYS', 'TRAVEL_PCT', 'ON_CALL', 'EMPLOYMENT_TYPE', 'LOCATION'
  )),
  fact_value JSONB NOT NULL CHECK (jsonb_typeof(fact_value) = 'object'),
  source_type TEXT NOT NULL CHECK (source_type IN (
    'RECRUITER_EMAIL', 'RECRUITER_CALL', 'EMPLOYER_CAREERS_PAGE', 'HIRING_MANAGER', 'OTHER'
  )),
  source_note TEXT CHECK (source_note IS NULL OR (BTRIM(source_note) <> '' AND LENGTH(source_note) <= 500)),
  source_url TEXT CHECK (source_url IS NULL OR (source_url ~ '^https?://[^\s/@]+(/[^\s]*)?$' AND LENGTH(source_url) <= 2048)),
  supersedes_fact_id UUID REFERENCES job_confirmed_facts(id) ON DELETE RESTRICT,
  recorded_by_user_id UUID NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (supersedes_fact_id IS NULL OR supersedes_fact_id <> id),
  -- Numeric casts sit inside CASE branches so a non-number never reaches a cast.
  CHECK (CASE fact_type
    WHEN 'WORK_MODE' THEN
      COALESCE(fact_value->>'work_mode' IN ('ONSITE', 'HYBRID', 'REMOTE'), FALSE)
    WHEN 'OFFICE_DAYS' THEN
      CASE
        WHEN jsonb_typeof(fact_value->'office_days_min') = 'number'
          AND jsonb_typeof(fact_value->'office_days_max') = 'number'
        THEN (fact_value->>'office_days_min')::numeric BETWEEN 0 AND 7
          AND (fact_value->>'office_days_max')::numeric BETWEEN 0 AND 7
          AND (fact_value->>'office_days_min')::numeric = TRUNC((fact_value->>'office_days_min')::numeric)
          AND (fact_value->>'office_days_max')::numeric = TRUNC((fact_value->>'office_days_max')::numeric)
          AND (fact_value->>'office_days_min')::numeric <= (fact_value->>'office_days_max')::numeric
        ELSE FALSE
      END
    WHEN 'TRAVEL_PCT' THEN
      CASE
        WHEN jsonb_typeof(fact_value->'travel_pct_max') = 'number'
        THEN (fact_value->>'travel_pct_max')::numeric BETWEEN 0 AND 100
        ELSE FALSE
      END
    WHEN 'ON_CALL' THEN
      jsonb_typeof(fact_value->'on_call_required') = 'boolean'
    WHEN 'EMPLOYMENT_TYPE' THEN
      COALESCE(fact_value->>'employment_type' IN ('PERMANENT', 'CONTRACT'), FALSE)
    WHEN 'LOCATION' THEN
      CASE
        WHEN jsonb_typeof(fact_value->'location') = 'string'
          AND jsonb_typeof(fact_value->'territories') = 'array'
        THEN BTRIM(fact_value->>'location') <> '' AND LENGTH(fact_value->>'location') <= 200
        ELSE FALSE
      END
    ELSE FALSE
  END)
);

-- One supersession per fact and one root per chain: exactly one current fact per job version/type.
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_confirmed_facts_superseded_once
  ON job_confirmed_facts (supersedes_fact_id)
  WHERE supersedes_fact_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_confirmed_facts_chain_root
  ON job_confirmed_facts (workspace_id, job_version_id, fact_type)
  WHERE supersedes_fact_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_job_confirmed_facts_job_version
  ON job_confirmed_facts (workspace_id, job_version_id, fact_type, recorded_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_job_confirmed_facts_canonical_job
  ON job_confirmed_facts (workspace_id, canonical_job_id, recorded_at DESC);

-- The fact belongs to the stated job version of the stated canonical job in the workspace, and a
-- superseding fact replaces a fact of the same job version and type.
CREATE OR REPLACE FUNCTION job_confirmed_facts_validate()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM job_versions version
    JOIN canonical_jobs job
      ON job.workspace_id = version.workspace_id
     AND job.id = version.canonical_job_id
    WHERE version.workspace_id = NEW.workspace_id
      AND version.id = NEW.job_version_id
      AND version.canonical_job_id = NEW.canonical_job_id
  ) THEN
    RAISE EXCEPTION 'Confirmed fact job version % does not belong to canonical job % in this workspace.',
      NEW.job_version_id, NEW.canonical_job_id;
  END IF;
  IF NEW.supersedes_fact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM job_confirmed_facts prior
    WHERE prior.id = NEW.supersedes_fact_id
      AND prior.workspace_id = NEW.workspace_id
      AND prior.job_version_id = NEW.job_version_id
      AND prior.fact_type = NEW.fact_type
  ) THEN
    RAISE EXCEPTION 'A confirmed fact can only supersede a fact of the same job version and fact type.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION job_confirmed_facts_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'job_confirmed_facts is append-only; correct a fact by recording a superseding fact.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_confirmed_facts_validate ON job_confirmed_facts;
CREATE TRIGGER job_confirmed_facts_validate
  BEFORE INSERT ON job_confirmed_facts
  FOR EACH ROW EXECUTE FUNCTION job_confirmed_facts_validate();

DROP TRIGGER IF EXISTS job_confirmed_facts_append_only ON job_confirmed_facts;
CREATE TRIGGER job_confirmed_facts_append_only
  BEFORE UPDATE OR DELETE ON job_confirmed_facts
  FOR EACH ROW EXECUTE FUNCTION job_confirmed_facts_append_only();

CREATE OR REPLACE VIEW v_job_confirmed_facts_current AS
SELECT
  fact.id AS confirmed_fact_id,
  fact.schema_version,
  fact.workspace_id,
  fact.canonical_job_id,
  fact.job_version_id,
  fact.fact_type,
  fact.fact_value,
  fact.source_type,
  fact.source_note,
  fact.source_url,
  fact.supersedes_fact_id,
  fact.recorded_by_user_id,
  fact.recorded_at
FROM job_confirmed_facts fact
WHERE NOT EXISTS (
  SELECT 1
  FROM job_confirmed_facts successor
  WHERE successor.supersedes_fact_id = fact.id
);

-- One row per current, non-archived, non-fixture job version. open_checks lists the fact types the
-- current gate decision or readiness assessment still needs and that have no current confirmed fact.
-- rerun_pending is true while a confirmed fact is newer than the job version's latest gate decision.
CREATE OR REPLACE VIEW v_job_verification_checks_scoped AS
WITH current_jobs AS (
  SELECT
    job.workspace_id,
    job.id AS canonical_job_id,
    job.latest_job_version_id AS job_version_id,
    job.latest_deterministic_decision_id
  FROM canonical_jobs job
  WHERE job.is_test_fixture = FALSE
    AND job.archived_at IS NULL
    AND job.latest_job_version_id IS NOT NULL
),
latest_gate AS (
  SELECT DISTINCT ON (gate.workspace_id, gate.job_version_id)
    gate.workspace_id,
    gate.job_version_id,
    gate.decision,
    gate.rejection_codes,
    gate.evidence_quotes,
    gate.workability_facts,
    gate.created_at
  FROM gate_decisions gate
  JOIN current_jobs current_job
    ON current_job.workspace_id = gate.workspace_id
   AND current_job.job_version_id = gate.job_version_id
  ORDER BY gate.workspace_id, gate.job_version_id, gate.created_at DESC, gate.id DESC
),
readiness_checks AS (
  SELECT
    current_job.canonical_job_id,
    check_item.value->>'key' AS check_key,
    check_item.value->>'reason_code' AS reason_code
  FROM current_jobs current_job
  JOIN deterministic_decisions decision
    ON decision.workspace_id = current_job.workspace_id
   AND decision.id = current_job.latest_deterministic_decision_id
   AND decision.job_version_id = current_job.job_version_id
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(decision.readiness_json->'checks') = 'array'
      THEN decision.readiness_json->'checks' ELSE '[]'::jsonb END
  ) AS check_item(value)
  WHERE check_item.value->>'status' = 'NEEDS_VERIFICATION'
),
needed_facts AS (
  SELECT current_job.canonical_job_id, mapped.fact_type
  FROM current_jobs current_job
  JOIN latest_gate gate
    ON gate.workspace_id = current_job.workspace_id
   AND gate.job_version_id = current_job.job_version_id
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(gate.rejection_codes) = 'array' THEN gate.rejection_codes ELSE '[]'::jsonb END
  ) AS code(value)
  CROSS JOIN LATERAL (
    SELECT CASE code.value
      WHEN 'GATE_UNKNOWN_WORK_MODE' THEN 'WORK_MODE'
      WHEN 'NEEDS_VERIFICATION_OFFICE_DAYS' THEN 'OFFICE_DAYS'
      WHEN 'NEEDS_VERIFICATION_TRAVEL' THEN 'TRAVEL_PCT'
      WHEN 'NEEDS_VERIFICATION_WORK_AUTHORIZATION' THEN 'LOCATION'
      WHEN 'NEEDS_VERIFICATION_HIRING_TERRITORY' THEN 'LOCATION'
      WHEN 'NEEDS_VERIFICATION_LOCATION_DETAIL' THEN 'LOCATION'
    END AS fact_type
  ) AS mapped
  WHERE gate.decision = 'NEEDS_VERIFICATION'
    AND mapped.fact_type IS NOT NULL
  UNION
  SELECT readiness.canonical_job_id, mapped.fact_type
  FROM readiness_checks readiness
  CROSS JOIN LATERAL (
    SELECT CASE readiness.check_key
      WHEN 'WORK_MODE' THEN 'WORK_MODE'
      WHEN 'TRAVEL' THEN 'TRAVEL_PCT'
      WHEN 'WORK_AUTHORIZATION' THEN 'LOCATION'
      WHEN 'EMPLOYMENT_ROUTE' THEN 'EMPLOYMENT_TYPE'
    END AS fact_type
  ) AS mapped
  WHERE mapped.fact_type IS NOT NULL
)
SELECT
  current_job.workspace_id,
  current_job.canonical_job_id,
  current_job.job_version_id,
  gate.decision AS gate_decision,
  COALESCE(gate.rejection_codes, '[]'::jsonb) AS gate_rejection_codes,
  COALESCE(gate.evidence_quotes, '[]'::jsonb) AS gate_evidence_quotes,
  gate.workability_facts AS gate_workability_facts,
  gate.created_at AS gate_decided_at,
  COALESCE((
    SELECT jsonb_agg(needed.fact_type ORDER BY needed.fact_type)
    FROM needed_facts needed
    WHERE needed.canonical_job_id = current_job.canonical_job_id
      AND NOT EXISTS (
        SELECT 1
        FROM v_job_confirmed_facts_current confirmed
        WHERE confirmed.workspace_id = current_job.workspace_id
          AND confirmed.job_version_id = current_job.job_version_id
          AND confirmed.fact_type = needed.fact_type
      )
  ), '[]'::jsonb) AS open_checks,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'confirmed_fact_id', confirmed.confirmed_fact_id,
      'fact_type', confirmed.fact_type,
      'fact_value', confirmed.fact_value,
      'source_type', confirmed.source_type,
      'source_note', confirmed.source_note,
      'source_url', confirmed.source_url,
      'supersedes_fact_id', confirmed.supersedes_fact_id,
      'recorded_by_user_id', confirmed.recorded_by_user_id,
      'recorded_at', confirmed.recorded_at
    ) ORDER BY confirmed.fact_type)
    FROM v_job_confirmed_facts_current confirmed
    WHERE confirmed.workspace_id = current_job.workspace_id
      AND confirmed.job_version_id = current_job.job_version_id
  ), '[]'::jsonb) AS confirmed_facts,
  (
    SELECT COUNT(*)::int
    FROM job_confirmed_facts history
    WHERE history.workspace_id = current_job.workspace_id
      AND history.job_version_id = current_job.job_version_id
  ) AS confirmed_fact_history_count,
  EXISTS (
    SELECT 1
    FROM v_job_confirmed_facts_current confirmed
    WHERE confirmed.workspace_id = current_job.workspace_id
      AND confirmed.job_version_id = current_job.job_version_id
      AND (gate.created_at IS NULL OR confirmed.recorded_at > gate.created_at)
  ) AS rerun_pending
FROM current_jobs current_job
LEFT JOIN latest_gate gate
  ON gate.workspace_id = current_job.workspace_id
 AND gate.job_version_id = current_job.job_version_id;

COMMENT ON TABLE job_confirmed_facts IS
  'Append-only, user-recorded employer confirmations of one job version''s workability facts, with source and recorder. Corrections supersede; nothing is updated or deleted.';
COMMENT ON VIEW v_job_confirmed_facts_current IS
  'The current (unsuperseded) employer-confirmed fact per job version and fact type.';
COMMENT ON VIEW v_job_verification_checks_scoped IS
  'Per current job version: gate workability facts, open verification checks without a confirmed fact, and the confirmed facts. Filter by workspace_id.';
