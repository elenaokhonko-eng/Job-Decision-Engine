-- Migration 066: Additive application command-centre V5 persistence and read models.
--
-- Adds immutable workspace ranking policies/snapshots and culture evidence,
-- workspace-scoped company identity, and scoped application/culture views.
-- Existing decision outcomes and historical application/job artifacts are not
-- rewritten. Missing culture signals remain NULL; ranking views never set or
-- change recommendation outcomes.

-- ============================================================================
-- 1) Immutable, versioned ranking policies
-- ============================================================================

CREATE TABLE IF NOT EXISTS ranking_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  schema_version TEXT NOT NULL DEFAULT '5.0.0',
  weights JSONB NOT NULL,
  minimum_ranking_confidence NUMERIC(5,2) NOT NULL DEFAULT 95.00,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ranking_policies_workspace_version_key UNIQUE (workspace_id, policy_version),
  CONSTRAINT ranking_policies_weights_chk CHECK (
    jsonb_typeof(weights) = 'object'
    AND (weights - ARRAY[
      'requirementFit',
      'requirementCoverage',
      'evidenceCompleteness',
      'laneConfidence',
      'autonomy',
      'politicsRisk',
      'sensoryWorkloadRisk',
      'strategicValue'
    ]::TEXT[]) = '{}'::JSONB
    AND weights ?& ARRAY[
      'requirementFit',
      'requirementCoverage',
      'evidenceCompleteness',
      'laneConfidence',
      'autonomy',
      'politicsRisk',
      'sensoryWorkloadRisk',
      'strategicValue'
    ]::TEXT[]
    AND jsonb_typeof(weights -> 'requirementFit') = 'number'
    AND jsonb_typeof(weights -> 'requirementCoverage') = 'number'
    AND jsonb_typeof(weights -> 'evidenceCompleteness') = 'number'
    AND jsonb_typeof(weights -> 'laneConfidence') = 'number'
    AND jsonb_typeof(weights -> 'autonomy') = 'number'
    AND jsonb_typeof(weights -> 'politicsRisk') = 'number'
    AND jsonb_typeof(weights -> 'sensoryWorkloadRisk') = 'number'
    AND jsonb_typeof(weights -> 'strategicValue') = 'number'
    AND (weights ->> 'requirementFit')::NUMERIC >= 0
    AND (weights ->> 'requirementCoverage')::NUMERIC >= 0
    AND (weights ->> 'evidenceCompleteness')::NUMERIC >= 0
    AND (weights ->> 'laneConfidence')::NUMERIC >= 0
    AND (weights ->> 'autonomy')::NUMERIC >= 0
    AND (weights ->> 'politicsRisk')::NUMERIC >= 0
    AND (weights ->> 'sensoryWorkloadRisk')::NUMERIC >= 0
    AND (weights ->> 'strategicValue')::NUMERIC >= 0
    AND (
      (weights ->> 'requirementFit')::NUMERIC
      + (weights ->> 'requirementCoverage')::NUMERIC
      + (weights ->> 'evidenceCompleteness')::NUMERIC
      + (weights ->> 'laneConfidence')::NUMERIC
      + (weights ->> 'autonomy')::NUMERIC
      + (weights ->> 'politicsRisk')::NUMERIC
      + (weights ->> 'sensoryWorkloadRisk')::NUMERIC
      + (weights ->> 'strategicValue')::NUMERIC
    ) = 100
  ),
  CONSTRAINT ranking_policies_minimum_confidence_chk
    CHECK (minimum_ranking_confidence BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_ranking_policies_workspace_version
  ON ranking_policies (workspace_id, policy_version DESC);

INSERT INTO ranking_policies (
  workspace_id,
  policy_version,
  weights,
  minimum_ranking_confidence
)
SELECT
  workspace.id,
  1,
  '{
    "requirementFit": 35,
    "requirementCoverage": 15,
    "evidenceCompleteness": 10,
    "laneConfidence": 10,
    "autonomy": 10,
    "politicsRisk": 7.5,
    "sensoryWorkloadRisk": 5,
    "strategicValue": 7.5
  }'::JSONB,
  95.00
FROM workspaces AS workspace
ON CONFLICT (workspace_id, policy_version) DO NOTHING;

CREATE OR REPLACE FUNCTION seed_default_ranking_policy_for_workspace()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO ranking_policies (
    workspace_id,
    policy_version,
    weights,
    minimum_ranking_confidence
  ) VALUES (
    NEW.id,
    1,
    '{
      "requirementFit": 35,
      "requirementCoverage": 15,
      "evidenceCompleteness": 10,
      "laneConfidence": 10,
      "autonomy": 10,
      "politicsRisk": 7.5,
      "sensoryWorkloadRisk": 5,
      "strategicValue": 7.5
    }'::JSONB,
    95.00
  )
  ON CONFLICT (workspace_id, policy_version) DO NOTHING;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_workspaces_seed_ranking_policy ON workspaces;
CREATE TRIGGER trg_workspaces_seed_ranking_policy
AFTER INSERT ON workspaces
FOR EACH ROW EXECUTE FUNCTION seed_default_ranking_policy_for_workspace();

-- ============================================================================
-- 2) Append-only job ranking snapshots
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_ranking_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE RESTRICT,
  job_version_id UUID NOT NULL REFERENCES job_versions(id) ON DELETE RESTRICT,
  profile_version_id UUID NOT NULL REFERENCES profile_versions(id) ON DELETE RESTRICT,
  match_run_id UUID NOT NULL REFERENCES match_runs(id) ON DELETE RESTRICT,
  deterministic_decision_id UUID NOT NULL REFERENCES deterministic_decisions(id) ON DELETE RESTRICT,
  ai_evaluation_id UUID NOT NULL REFERENCES ai_evaluations(id) ON DELETE RESTRICT,
  ranking_policy_version INTEGER NOT NULL,
  context_fingerprint TEXT NOT NULL CHECK (BTRIM(context_fingerprint) <> ''),
  schema_version TEXT NOT NULL DEFAULT '5.0.0',

  requirement_fit_score NUMERIC(5,2),
  requirement_coverage_score NUMERIC(5,2),
  evidence_completeness_score NUMERIC(5,2),
  lane_confidence_score NUMERIC(5,2),
  autonomy_score NUMERIC(5,2),
  politics_risk_score NUMERIC(5,2),
  sensory_workload_risk_score NUMERIC(5,2),
  strategic_value_score NUMERIC(5,2),
  focus_protection_score NUMERIC(5,2),
  building_ratio_score NUMERIC(5,2),
  interaction_burden_score NUMERIC(5,2),
  overall_rank_score NUMERIC(7,3) NOT NULL,
  ranking_confidence NUMERIC(5,2) NOT NULL,
  is_top_ten_ready BOOLEAN NOT NULL DEFAULT FALSE,
  policy_recheck_required BOOLEAN NOT NULL DEFAULT TRUE,
  component_availability JSONB NOT NULL DEFAULT '{}'::JSONB,
  component_provenance JSONB NOT NULL DEFAULT '{}'::JSONB,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT job_ranking_snapshots_policy_fk
    FOREIGN KEY (workspace_id, ranking_policy_version)
    REFERENCES ranking_policies (workspace_id, policy_version) ON DELETE RESTRICT,
  CONSTRAINT job_ranking_snapshots_context_key UNIQUE (
    workspace_id,
    canonical_job_id,
    job_version_id,
    profile_version_id,
    match_run_id,
    deterministic_decision_id,
    ai_evaluation_id,
    ranking_policy_version,
    context_fingerprint
  ),
  CONSTRAINT job_ranking_snapshots_component_scores_chk CHECK (
    (requirement_fit_score IS NULL OR requirement_fit_score BETWEEN 0 AND 100)
    AND (requirement_coverage_score IS NULL OR requirement_coverage_score BETWEEN 0 AND 100)
    AND (evidence_completeness_score IS NULL OR evidence_completeness_score BETWEEN 0 AND 100)
    AND (lane_confidence_score IS NULL OR lane_confidence_score BETWEEN 0 AND 100)
    AND (autonomy_score IS NULL OR autonomy_score BETWEEN 0 AND 100)
    AND (politics_risk_score IS NULL OR politics_risk_score BETWEEN 0 AND 100)
    AND (sensory_workload_risk_score IS NULL OR sensory_workload_risk_score BETWEEN 0 AND 100)
    AND (strategic_value_score IS NULL OR strategic_value_score BETWEEN 0 AND 100)
    AND (focus_protection_score IS NULL OR focus_protection_score BETWEEN 0 AND 100)
    AND (building_ratio_score IS NULL OR building_ratio_score BETWEEN 0 AND 100)
    AND (interaction_burden_score IS NULL OR interaction_burden_score BETWEEN 0 AND 100)
    AND overall_rank_score BETWEEN 0 AND 100
    AND ranking_confidence BETWEEN 0 AND 100
  ),
  CONSTRAINT job_ranking_snapshots_component_json_chk CHECK (
    jsonb_typeof(component_availability) = 'object'
    AND jsonb_typeof(component_provenance) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS idx_job_ranking_snapshots_workspace_rank
  ON job_ranking_snapshots (workspace_id, overall_rank_score DESC, ranking_confidence DESC);
CREATE INDEX IF NOT EXISTS idx_job_ranking_snapshots_job_context
  ON job_ranking_snapshots (
    workspace_id,
    canonical_job_id,
    job_version_id,
    profile_version_id,
    match_run_id,
    deterministic_decision_id,
    created_at DESC
  );
CREATE INDEX IF NOT EXISTS idx_job_ranking_snapshots_ready
  ON job_ranking_snapshots (workspace_id, ranking_confidence DESC, overall_rank_score DESC)
  WHERE is_top_ten_ready = TRUE AND policy_recheck_required = FALSE;

-- ============================================================================
-- 3) Workspace-scoped company identity and append-only culture evidence
-- ============================================================================

CREATE TABLE IF NOT EXISTS workspace_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL CHECK (BTRIM(company_name) <> ''),
  normalized_company_name TEXT NOT NULL CHECK (BTRIM(normalized_company_name) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workspace_companies_workspace_normalized_name_key
    UNIQUE (workspace_id, normalized_company_name),
  CONSTRAINT workspace_companies_workspace_id_key UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_companies_workspace_name
  ON workspace_companies (workspace_id, company_name);

INSERT INTO workspace_companies (workspace_id, company_name, normalized_company_name)
SELECT DISTINCT
  canonical.workspace_id,
  BTRIM(canonical.company_name),
  REGEXP_REPLACE(LOWER(BTRIM(canonical.company_name)), '[[:space:]]+', ' ', 'g')
FROM canonical_jobs AS canonical
WHERE canonical.is_test_fixture = FALSE
  AND NULLIF(BTRIM(canonical.company_name), '') IS NOT NULL
ON CONFLICT (workspace_id, normalized_company_name) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_canonical_jobs_workspace_company_name
  ON canonical_jobs (workspace_id, company_name);

CREATE OR REPLACE FUNCTION materialize_workspace_company_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NULLIF(BTRIM(NEW.company_name), '') IS NOT NULL AND NEW.is_test_fixture = FALSE THEN
    INSERT INTO workspace_companies (workspace_id, company_name, normalized_company_name)
    VALUES (
      NEW.workspace_id,
      BTRIM(NEW.company_name),
      REGEXP_REPLACE(LOWER(BTRIM(NEW.company_name)), '[[:space:]]+', ' ', 'g')
    )
    ON CONFLICT (workspace_id, normalized_company_name)
    DO UPDATE SET company_name = EXCLUDED.company_name, updated_at = NOW();
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_canonical_jobs_workspace_company_identity ON canonical_jobs;
CREATE TRIGGER trg_canonical_jobs_workspace_company_identity
AFTER INSERT OR UPDATE OF company_name, workspace_id ON canonical_jobs
FOR EACH ROW EXECUTE FUNCTION materialize_workspace_company_identity();

CREATE TABLE IF NOT EXISTS company_culture_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  workspace_company_id UUID NOT NULL,
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE RESTRICT,
  job_version_id UUID NOT NULL REFERENCES job_versions(id) ON DELETE RESTRICT,
  ai_evaluation_id UUID NOT NULL REFERENCES ai_evaluations(id) ON DELETE RESTRICT,

  autonomy_signal NUMERIC(5,2),
  politics_risk_signal NUMERIC(5,2),
  sensory_workload_risk_signal NUMERIC(5,2),
  strategic_value_signal NUMERIC(5,2),
  focus_protection_signal NUMERIC(5,2),
  source_type TEXT NOT NULL CHECK (BTRIM(source_type) <> ''),
  source_url TEXT,
  evidence_quote TEXT,
  evidence_hash TEXT NOT NULL CHECK (BTRIM(evidence_hash) <> ''),
  evidence_by_signal JSONB NOT NULL DEFAULT '{}'::JSONB,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT company_culture_observations_workspace_company_fk
    FOREIGN KEY (workspace_id, workspace_company_id)
    REFERENCES workspace_companies (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT company_culture_observations_workspace_evaluation_key
    UNIQUE (workspace_id, ai_evaluation_id),
  CONSTRAINT company_culture_observations_signal_scores_chk CHECK (
    (autonomy_signal IS NULL OR autonomy_signal BETWEEN 0 AND 100)
    AND (politics_risk_signal IS NULL OR politics_risk_signal BETWEEN 0 AND 100)
    AND (sensory_workload_risk_signal IS NULL OR sensory_workload_risk_signal BETWEEN 0 AND 100)
    AND (strategic_value_signal IS NULL OR strategic_value_signal BETWEEN 0 AND 100)
    AND (focus_protection_signal IS NULL OR focus_protection_signal BETWEEN 0 AND 100)
  ),
  CONSTRAINT company_culture_observations_evidence_map_chk
    CHECK (jsonb_typeof(evidence_by_signal) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_company_culture_observations_company_time
  ON company_culture_observations (workspace_id, workspace_company_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_company_culture_observations_job_version
  ON company_culture_observations (workspace_id, canonical_job_id, job_version_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_company_culture_observations_evaluation
  ON company_culture_observations (workspace_id, ai_evaluation_id);

-- Advisory AI conflict requests are auditable workflow records. Resolving one
-- never writes to canonical_jobs or changes gate/recommendation outcomes.
CREATE TABLE IF NOT EXISTS policy_recheck_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE RESTRICT,
  job_version_id UUID NOT NULL REFERENCES job_versions(id) ON DELETE RESTRICT,
  profile_version_id UUID NOT NULL REFERENCES profile_versions(id) ON DELETE RESTRICT,
  match_run_id UUID NOT NULL REFERENCES match_runs(id) ON DELETE RESTRICT,
  deterministic_decision_id UUID NOT NULL REFERENCES deterministic_decisions(id) ON DELETE RESTRICT,
  ai_evaluation_id UUID NOT NULL REFERENCES ai_evaluations(id) ON DELETE RESTRICT,
  ranking_policy_version INTEGER NOT NULL,
  context_fingerprint TEXT NOT NULL CHECK (BTRIM(context_fingerprint) <> ''),
  policy_code TEXT NOT NULL CHECK (BTRIM(policy_code) <> ''),
  reason_code TEXT NOT NULL CHECK (BTRIM(reason_code) <> ''),
  evidence_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  candidate_constraint TEXT NOT NULL CHECK (BTRIM(candidate_constraint) <> ''),
  role_requirement TEXT NOT NULL CHECK (BTRIM(role_requirement) <> ''),
  evidence_quote TEXT NOT NULL CHECK (BTRIM(evidence_quote) <> ''),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'RESOLVED', 'DISMISSED', 'SUPERSEDED')),
  resolution_outcome TEXT,
  resolved_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT policy_recheck_requests_policy_version_fk
    FOREIGN KEY (workspace_id, ranking_policy_version)
    REFERENCES ranking_policies (workspace_id, policy_version) ON DELETE RESTRICT,
  CONSTRAINT policy_recheck_requests_evaluation_policy_quote_key
    UNIQUE (workspace_id, ai_evaluation_id, policy_code, evidence_quote),
  CONSTRAINT policy_recheck_requests_evidence_payload_chk
    CHECK (jsonb_typeof(evidence_payload) = 'object'),
  CONSTRAINT policy_recheck_requests_resolution_chk CHECK (
    (status = 'PENDING' AND resolution_outcome IS NULL AND resolved_at IS NULL)
    OR (
      status <> 'PENDING'
      AND resolution_outcome IS NOT NULL
      AND BTRIM(resolution_outcome) <> ''
      AND resolved_at IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_policy_recheck_requests_pending_context
  ON policy_recheck_requests (
    workspace_id,
    canonical_job_id,
    job_version_id,
    context_fingerprint,
    ai_evaluation_id
  )
  WHERE status = 'PENDING';

CREATE OR REPLACE FUNCTION policy_recheck_request_audit_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'policy_recheck_requests are auditable records and cannot be deleted.';
  END IF;

  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Resolved policy_recheck_requests are immutable.';
  END IF;

  IF ROW(
    NEW.workspace_id,
    NEW.canonical_job_id,
    NEW.job_version_id,
    NEW.profile_version_id,
    NEW.match_run_id,
    NEW.deterministic_decision_id,
    NEW.ai_evaluation_id,
    NEW.ranking_policy_version,
    NEW.context_fingerprint,
    NEW.policy_code,
    NEW.reason_code,
    NEW.evidence_payload,
    NEW.candidate_constraint,
    NEW.role_requirement,
    NEW.evidence_quote,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.workspace_id,
    OLD.canonical_job_id,
    OLD.job_version_id,
    OLD.profile_version_id,
    OLD.match_run_id,
    OLD.deterministic_decision_id,
    OLD.ai_evaluation_id,
    OLD.ranking_policy_version,
    OLD.context_fingerprint,
    OLD.policy_code,
    OLD.reason_code,
    OLD.evidence_payload,
    OLD.candidate_constraint,
    OLD.role_requirement,
    OLD.evidence_quote,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Policy recheck evidence and identity are immutable after insertion.';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_policy_recheck_requests_audit_guard ON policy_recheck_requests;
CREATE TRIGGER trg_policy_recheck_requests_audit_guard
BEFORE UPDATE OR DELETE ON policy_recheck_requests
FOR EACH ROW EXECUTE FUNCTION policy_recheck_request_audit_guard();

CREATE OR REPLACE FUNCTION materialize_v5_evaluation_signals(evaluation ai_evaluations)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  current_context RECORD;
  workspace_company_id UUID;
  evidence_by_signal JSONB;
  evidence_summary TEXT;
  recheck JSONB;
  recheck_id UUID;
BEGIN
  IF evaluation.full_evaluation_payload IS NULL
     OR evaluation.context_fingerprint IS NULL
     OR evaluation.profile_version_id IS NULL
     OR evaluation.match_run_id IS NULL
     OR evaluation.deterministic_decision_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    job.workspace_id,
    job.id AS canonical_job_id,
    job.company_name,
    job.canonical_url,
    job_version.id AS job_version_id,
    job_version.content_hash,
    active_profile.id AS profile_version_id,
    match_run.id AS match_run_id,
    decision.id AS deterministic_decision_id,
    decision.context_fingerprint
  INTO current_context
  FROM canonical_jobs AS job
  JOIN job_versions AS job_version
    ON job_version.workspace_id = job.workspace_id
   AND job_version.canonical_job_id = job.id
   AND job_version.id = job.latest_job_version_id
   AND job_version.id = evaluation.job_version_id
  JOIN LATERAL (
    SELECT profile.id
    FROM profile_versions AS profile
    WHERE profile.workspace_id = job.workspace_id
      AND profile.status = 'ACTIVE'
    ORDER BY profile.created_at DESC, profile.id DESC
    LIMIT 1
  ) AS active_profile ON TRUE
  JOIN match_runs AS match_run
    ON match_run.workspace_id = job.workspace_id
   AND match_run.id = job.latest_match_run_id
   AND match_run.id = evaluation.match_run_id
   AND match_run.canonical_job_id = job.id
   AND match_run.job_version_id = job_version.id
   AND match_run.profile_version_id = active_profile.id
   AND match_run.status = 'COMPLETED'
   AND match_run.job_content_hash = job_version.content_hash
  JOIN deterministic_decisions AS decision
    ON decision.workspace_id = job.workspace_id
   AND decision.id = job.latest_deterministic_decision_id
   AND decision.id = evaluation.deterministic_decision_id
   AND decision.canonical_job_id = job.id
   AND decision.job_version_id = job_version.id
   AND decision.match_run_id = match_run.id
   AND decision.context_fingerprint = evaluation.context_fingerprint
  WHERE job.workspace_id = evaluation.workspace_id
    AND job.id = evaluation.canonical_job_id
    AND active_profile.id = evaluation.profile_version_id
    AND match_run.context_fingerprint IS NOT NULL
    AND evaluation.job_content_hash = job_version.content_hash
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO workspace_companies (workspace_id, company_name, normalized_company_name)
  VALUES (
    current_context.workspace_id,
    BTRIM(current_context.company_name),
    REGEXP_REPLACE(LOWER(BTRIM(current_context.company_name)), '[[:space:]]+', ' ', 'g')
  )
  ON CONFLICT (workspace_id, normalized_company_name)
  DO UPDATE SET updated_at = NOW()
  RETURNING id INTO workspace_company_id;

  SELECT
    COALESCE(
      jsonb_object_agg(
        signal.value ->> 'signal',
        jsonb_build_object('score', signal.value -> 'score', 'quote', signal.value -> 'quote')
      ),
      '{}'::JSONB
    ),
    STRING_AGG(NULLIF(signal.value ->> 'quote', ''), E'\n' ORDER BY signal.value ->> 'signal')
  INTO evidence_by_signal, evidence_summary
  FROM jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(evaluation.full_evaluation_payload -> 'culture_evidence') = 'array'
        THEN evaluation.full_evaluation_payload -> 'culture_evidence'
      ELSE '[]'::JSONB
    END
  ) AS signal(value);

  INSERT INTO company_culture_observations (
    workspace_id,
    workspace_company_id,
    canonical_job_id,
    job_version_id,
    ai_evaluation_id,
    autonomy_signal,
    politics_risk_signal,
    sensory_workload_risk_signal,
    focus_protection_signal,
    strategic_value_signal,
    source_type,
    source_url,
    evidence_quote,
    evidence_hash,
    evidence_by_signal
  ) VALUES (
    evaluation.workspace_id,
    workspace_company_id,
    evaluation.canonical_job_id,
    evaluation.job_version_id,
    evaluation.id,
    NULLIF(evaluation.full_evaluation_payload ->> 'nd_friendly_score', '')::NUMERIC,
    NULLIF(evaluation.full_evaluation_payload ->> 'politics_stress_score', '')::NUMERIC,
    NULLIF(evaluation.full_evaluation_payload ->> 'sensory_overload_index', '')::NUMERIC,
    NULLIF(evaluation.full_evaluation_payload ->> 'focus_protection_score', '')::NUMERIC,
    NULLIF(evaluation.full_evaluation_payload ->> 'strategic_value_score', '')::NUMERIC,
    'CURRENT_JOB_DESCRIPTION_EVALUATION',
    current_context.canonical_url,
    evidence_summary,
    MD5(evaluation.full_evaluation_payload::TEXT || evaluation.context_fingerprint),
    evidence_by_signal
  ) ON CONFLICT (workspace_id, ai_evaluation_id) DO NOTHING;

  FOR recheck IN
    SELECT conflict.value
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(evaluation.full_evaluation_payload -> 'policy_conflicts') = 'array'
          THEN evaluation.full_evaluation_payload -> 'policy_conflicts'
        ELSE '[]'::JSONB
      END
    ) AS conflict(value)
  LOOP
    INSERT INTO policy_recheck_requests (
      workspace_id,
      canonical_job_id,
      job_version_id,
      profile_version_id,
      match_run_id,
      deterministic_decision_id,
      ai_evaluation_id,
      ranking_policy_version,
      context_fingerprint,
      policy_code,
      reason_code,
      evidence_payload,
      candidate_constraint,
      role_requirement,
      evidence_quote
    ) VALUES (
      evaluation.workspace_id,
      evaluation.canonical_job_id,
      evaluation.job_version_id,
      evaluation.profile_version_id,
      evaluation.match_run_id,
      evaluation.deterministic_decision_id,
      evaluation.id,
      (SELECT MAX(policy.policy_version) FROM ranking_policies AS policy WHERE policy.workspace_id = evaluation.workspace_id),
      evaluation.context_fingerprint,
      recheck ->> 'policy',
      recheck ->> 'policy',
      jsonb_build_object(
        'candidate_constraint', recheck ->> 'candidate_constraint',
        'role_requirement', recheck ->> 'role_requirement',
        'evidence', recheck ->> 'evidence'
      ),
      recheck ->> 'candidate_constraint',
      recheck ->> 'role_requirement',
      recheck ->> 'evidence'
    )
    ON CONFLICT (workspace_id, ai_evaluation_id, policy_code, evidence_quote) DO NOTHING
    RETURNING id INTO recheck_id;

    IF recheck_id IS NULL THEN
      SELECT request.id INTO recheck_id
      FROM policy_recheck_requests AS request
      WHERE request.workspace_id = evaluation.workspace_id
        AND request.ai_evaluation_id = evaluation.id
        AND request.policy_code = recheck ->> 'policy'
        AND request.evidence_quote = recheck ->> 'evidence'
      LIMIT 1;
    END IF;

    INSERT INTO pipeline_tasks (
      workspace_id,
      task_type,
      task_key,
      context_fingerprint,
      payload
    ) VALUES (
      evaluation.workspace_id,
      'APPLY_HARD_GATES',
      'policy-recheck:' || recheck_id::TEXT,
      evaluation.context_fingerprint,
      jsonb_build_object(
        'canonical_job_id', evaluation.canonical_job_id,
        'job_version_id', evaluation.job_version_id,
        'policy_recheck_request_id', recheck_id,
        'force_policy_recalculation', TRUE,
        'reprocess', TRUE
      )
    ) ON CONFLICT (workspace_id, task_key, context_fingerprint) DO NOTHING;
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION materialize_v5_evaluation_signals_after_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM materialize_v5_evaluation_signals(NEW);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_ai_evaluations_materialize_v5_signals ON ai_evaluations;
CREATE TRIGGER trg_ai_evaluations_materialize_v5_signals
AFTER INSERT ON ai_evaluations
FOR EACH ROW EXECUTE FUNCTION materialize_v5_evaluation_signals_after_insert();

DO $$
DECLARE
  evaluation ai_evaluations%ROWTYPE;
BEGIN
  FOR evaluation IN
    SELECT ai_evaluation.*
    FROM ai_evaluations AS ai_evaluation
    JOIN canonical_jobs AS job
      ON job.workspace_id = ai_evaluation.workspace_id
     AND job.id = ai_evaluation.canonical_job_id
     AND job.latest_job_version_id = ai_evaluation.job_version_id
     AND job.latest_match_run_id = ai_evaluation.match_run_id
     AND job.latest_deterministic_decision_id = ai_evaluation.deterministic_decision_id
    JOIN profile_versions AS profile
      ON profile.workspace_id = ai_evaluation.workspace_id
     AND profile.id = ai_evaluation.profile_version_id
     AND profile.status = 'ACTIVE'
    WHERE ai_evaluation.context_fingerprint IS NOT NULL
      AND ai_evaluation.job_content_hash IS NOT NULL
  LOOP
    PERFORM materialize_v5_evaluation_signals(evaluation);
  END LOOP;
END
$$;

-- Shared append-only guard for policy, ranking, and culture evidence records.
CREATE OR REPLACE FUNCTION application_command_centre_v5_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable; insert a new version or observation instead.', TG_TABLE_NAME;
END
$$;

DROP TRIGGER IF EXISTS trg_ranking_policies_immutable ON ranking_policies;
CREATE TRIGGER trg_ranking_policies_immutable
BEFORE UPDATE OR DELETE ON ranking_policies
FOR EACH ROW EXECUTE FUNCTION application_command_centre_v5_immutable_guard();

DROP TRIGGER IF EXISTS trg_job_ranking_snapshots_immutable ON job_ranking_snapshots;
CREATE TRIGGER trg_job_ranking_snapshots_immutable
BEFORE UPDATE OR DELETE ON job_ranking_snapshots
FOR EACH ROW EXECUTE FUNCTION application_command_centre_v5_immutable_guard();

DROP TRIGGER IF EXISTS trg_company_culture_observations_immutable ON company_culture_observations;
CREATE TRIGGER trg_company_culture_observations_immutable
BEFORE UPDATE OR DELETE ON company_culture_observations
FOR EACH ROW EXECUTE FUNCTION application_command_centre_v5_immutable_guard();

-- ============================================================================
-- 4) Additive application status extension
-- ============================================================================

DO $$
DECLARE
  existing_constraint RECORD;
BEGIN
  FOR existing_constraint IN
    SELECT constraint_row.conname
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = to_regclass(format('%I.%I', current_schema(), 'application_records'))
      AND constraint_row.contype = 'c'
      AND pg_get_constraintdef(constraint_row.oid) ILIKE '%status%'
  LOOP
    EXECUTE FORMAT(
      'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I',
      current_schema(),
      'application_records',
      existing_constraint.conname
    );
  END LOOP;
END
$$;

ALTER TABLE application_records
  ADD CONSTRAINT application_records_status_v5_check CHECK (status IN (
    'TO_APPLY',
    'APPLIED',
    'ASSESSMENT',
    'INTENT',
    'READY_TO_APPLY',
    'SUBMITTED',
    'FOLLOW_UP',
    'INTERVIEW',
    'OFFER',
    'REJECTED',
    'WITHDRAWN',
    'CLOSED'
  ));

COMMENT ON CONSTRAINT application_records_status_v5_check ON application_records IS
  'Supports the V5 application workflow while retaining every legacy application status.';

-- ============================================================================
-- 5) Current-context document provenance
-- ============================================================================

ALTER TABLE document_runs
  ADD COLUMN IF NOT EXISTS profile_version_id UUID REFERENCES profile_versions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS deterministic_decision_id UUID REFERENCES deterministic_decisions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS context_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_document_runs_current_context
  ON document_runs (
    workspace_id,
    canonical_job_id,
    job_version_id,
    profile_version_id,
    match_run_id,
    deterministic_decision_id,
    document_type,
    created_at DESC
  );

COMMENT ON COLUMN document_runs.profile_version_id IS
  'Profile version used by a current-context document; NULL marks a historical document created before V5 provenance.';
COMMENT ON COLUMN document_runs.deterministic_decision_id IS
  'Deterministic decision used by a current-context document; NULL marks legacy historical provenance.';
COMMENT ON COLUMN document_runs.context_fingerprint IS
  'Exact deterministic context fingerprint required for a document to be considered current.';

-- ============================================================================
-- 6) Scoped application command-centre read models
-- ============================================================================

CREATE OR REPLACE VIEW v_apply_now_jobs_scoped AS
WITH current_decisions AS (
  SELECT
    shortlist.*,
    ranking.overall_rank_score,
    ranking.ranking_confidence,
    ranking.id AS ranking_snapshot_id,
    EXISTS (
      SELECT 1
      FROM policy_recheck_requests AS recheck
      JOIN ai_evaluations AS recheck_evaluation
        ON recheck_evaluation.id = recheck.ai_evaluation_id
       AND recheck_evaluation.workspace_id = job.workspace_id
       AND recheck_evaluation.canonical_job_id = job.id
       AND recheck_evaluation.job_version_id = job_version.id
       AND recheck_evaluation.profile_version_id = active_profile.id
       AND recheck_evaluation.match_run_id = match_run.id
       AND recheck_evaluation.deterministic_decision_id = decision.id
       AND recheck_evaluation.job_content_hash = job_version.content_hash
       AND recheck_evaluation.context_fingerprint = decision.context_fingerprint
      WHERE recheck.workspace_id = job.workspace_id
        AND recheck.canonical_job_id = job.id
        AND recheck.job_version_id = job_version.id
        AND recheck.context_fingerprint = decision.context_fingerprint
        AND recheck.status = 'PENDING'
    ) AS policy_recheck_required
  FROM v_canonical_shortlist_scoped AS shortlist
  JOIN canonical_jobs AS job
    ON job.id = shortlist.canonical_job_id
   AND job.workspace_id = shortlist.workspace_id
  JOIN job_versions AS job_version
    ON job_version.id = shortlist.job_version_id::UUID
   AND job_version.workspace_id = job.workspace_id
   AND job_version.canonical_job_id = job.id
   AND job.latest_job_version_id = job_version.id
  JOIN LATERAL (
    SELECT profile.id
    FROM profile_versions AS profile
    WHERE profile.workspace_id = job.workspace_id
      AND profile.status = 'ACTIVE'
    ORDER BY profile.created_at DESC, profile.id DESC
    LIMIT 1
  ) AS active_profile ON TRUE
  JOIN match_runs AS match_run
    ON match_run.workspace_id = job.workspace_id
   AND match_run.id = job.latest_match_run_id
   AND match_run.canonical_job_id = job.id
   AND match_run.job_version_id = job_version.id
   AND match_run.profile_version_id = active_profile.id
   AND match_run.status = 'COMPLETED'
   AND job_version.active_requirement_set_id IS NOT NULL
   AND match_run.requirement_set_id = job_version.active_requirement_set_id
   AND match_run.job_content_hash = job_version.content_hash
   AND match_run.context_fingerprint IS NOT NULL
  JOIN deterministic_decisions AS decision
    ON decision.workspace_id = job.workspace_id
   AND decision.id = job.latest_deterministic_decision_id
   AND decision.canonical_job_id = job.id
   AND decision.job_version_id = job_version.id
   AND decision.match_run_id = match_run.id
   AND decision.context_fingerprint IS NOT NULL
   AND decision.recommendation_eligibility = shortlist.recommendation_eligibility
   AND decision.recommendation_outcome = shortlist.recommendation_outcome  LEFT JOIN LATERAL (
    SELECT snapshot.id, snapshot.overall_rank_score, snapshot.ranking_confidence
    FROM ai_evaluations AS evaluation
    JOIN job_ranking_snapshots AS snapshot
      ON snapshot.workspace_id = evaluation.workspace_id
     AND snapshot.canonical_job_id = evaluation.canonical_job_id
     AND snapshot.job_version_id = evaluation.job_version_id
     AND snapshot.profile_version_id = evaluation.profile_version_id
     AND snapshot.match_run_id = evaluation.match_run_id
     AND snapshot.deterministic_decision_id = evaluation.deterministic_decision_id
     AND snapshot.ai_evaluation_id = evaluation.id
     AND snapshot.context_fingerprint = evaluation.context_fingerprint
    WHERE evaluation.workspace_id = job.workspace_id
      AND evaluation.canonical_job_id = job.id
      AND evaluation.job_version_id = job_version.id
      AND evaluation.profile_version_id = active_profile.id
      AND evaluation.match_run_id = match_run.id
      AND evaluation.deterministic_decision_id = decision.id
      AND evaluation.job_content_hash = job_version.content_hash
      AND evaluation.context_fingerprint = decision.context_fingerprint
      AND snapshot.ranking_policy_version = (
        SELECT MAX(current_policy.policy_version)
        FROM ranking_policies AS current_policy
        WHERE current_policy.workspace_id = job.workspace_id
      )
    ORDER BY snapshot.computed_at DESC, snapshot.id
    LIMIT 1
  ) AS ranking ON TRUE
  WHERE shortlist.gate_status = 'PASS'
    AND shortlist.current_artifact_status IN (
      'CURRENT_OR_NOT_APPLICABLE',
      'EVALUATION_MISSING',
      'EVALUATION_STALE'
    )
)
SELECT current_decisions.*
FROM current_decisions
WHERE current_decisions.recommendation_eligibility = 'ELIGIBLE'
  AND current_decisions.recommendation_outcome IN ('PRIORITY', 'REVIEW');

CREATE OR REPLACE VIEW v_track_jobs_scoped AS
WITH current_decisions AS (
  SELECT
    shortlist.*,
    decision.id AS deterministic_decision_id,
    decision.context_fingerprint AS deterministic_context_fingerprint,
    decision.decision_json -> 'trace' -> 'notes' AS deterministic_trace_notes
  FROM v_canonical_shortlist_scoped AS shortlist
  JOIN canonical_jobs AS job
    ON job.id = shortlist.canonical_job_id
   AND job.workspace_id = shortlist.workspace_id
  JOIN job_versions AS job_version
    ON job_version.id = shortlist.job_version_id::UUID
   AND job_version.workspace_id = job.workspace_id
   AND job_version.canonical_job_id = job.id
   AND job.latest_job_version_id = job_version.id
  JOIN LATERAL (
    SELECT profile.id
    FROM profile_versions AS profile
    WHERE profile.workspace_id = job.workspace_id
      AND profile.status = 'ACTIVE'
    ORDER BY profile.created_at DESC, profile.id DESC
    LIMIT 1
  ) AS active_profile ON TRUE
  JOIN match_runs AS match_run
    ON match_run.workspace_id = job.workspace_id
   AND match_run.id = job.latest_match_run_id
   AND match_run.canonical_job_id = job.id
   AND match_run.job_version_id = job_version.id
   AND match_run.profile_version_id = active_profile.id
   AND match_run.status = 'COMPLETED'
   AND job_version.active_requirement_set_id IS NOT NULL
   AND match_run.requirement_set_id = job_version.active_requirement_set_id
   AND match_run.job_content_hash = job_version.content_hash
   AND match_run.context_fingerprint IS NOT NULL
  JOIN deterministic_decisions AS decision
    ON decision.workspace_id = job.workspace_id
   AND decision.id = job.latest_deterministic_decision_id
   AND decision.canonical_job_id = job.id
   AND decision.job_version_id = job_version.id
   AND decision.match_run_id = match_run.id
   AND decision.context_fingerprint IS NOT NULL
   AND decision.recommendation_eligibility = shortlist.recommendation_eligibility
   AND decision.recommendation_outcome = shortlist.recommendation_outcome
  WHERE shortlist.gate_status = 'PASS'
    AND shortlist.current_artifact_status IN (
      'CURRENT_OR_NOT_APPLICABLE',
      'EVALUATION_MISSING',
      'EVALUATION_STALE'
    )
)
SELECT current_decisions.*
FROM current_decisions
WHERE current_decisions.recommendation_outcome = 'TRACK';

CREATE OR REPLACE VIEW v_top_ten_ready_jobs_scoped AS
WITH current_rankings AS (
  SELECT
    shortlist.*,
    ranking.id AS ranking_snapshot_id,
    ranking.ranking_policy_version,
    ranking.context_fingerprint AS ranking_context_fingerprint,
    ranking.overall_rank_score,
    ranking.ranking_confidence,
    ranking.is_top_ten_ready,
    ranking.policy_recheck_required,
    ROW_NUMBER() OVER (
      PARTITION BY shortlist.workspace_id
      ORDER BY ranking.overall_rank_score DESC,
               ranking.ranking_confidence DESC,
               ranking.computed_at DESC,
               ranking.id
    ) AS ranking_position
  FROM v_canonical_shortlist_scoped AS shortlist
  JOIN canonical_jobs AS job
    ON job.id = shortlist.canonical_job_id
   AND job.workspace_id = shortlist.workspace_id
  JOIN job_versions AS job_version
    ON job_version.id = shortlist.job_version_id::UUID
   AND job_version.workspace_id = job.workspace_id
   AND job_version.canonical_job_id = job.id
   AND job.latest_job_version_id = job_version.id
  JOIN LATERAL (
    SELECT profile.id
    FROM profile_versions AS profile
    WHERE profile.workspace_id = job.workspace_id
      AND profile.status = 'ACTIVE'
    ORDER BY profile.created_at DESC, profile.id DESC
    LIMIT 1
  ) AS active_profile ON TRUE
  JOIN match_runs AS match_run
    ON match_run.workspace_id = job.workspace_id
   AND match_run.id = job.latest_match_run_id
   AND match_run.canonical_job_id = job.id
   AND match_run.job_version_id = job_version.id
   AND match_run.profile_version_id = active_profile.id
   AND match_run.status = 'COMPLETED'
   AND job_version.active_requirement_set_id IS NOT NULL
   AND match_run.requirement_set_id = job_version.active_requirement_set_id
   AND match_run.job_content_hash = job_version.content_hash
   AND match_run.context_fingerprint IS NOT NULL
  JOIN deterministic_decisions AS decision
    ON decision.workspace_id = job.workspace_id
   AND decision.id = job.latest_deterministic_decision_id
   AND decision.canonical_job_id = job.id
   AND decision.job_version_id = job_version.id
   AND decision.match_run_id = match_run.id
   AND decision.context_fingerprint IS NOT NULL
  JOIN LATERAL (
    SELECT evaluation.*
    FROM ai_evaluations AS evaluation
    WHERE evaluation.workspace_id = job.workspace_id
      AND evaluation.canonical_job_id = job.id
      AND evaluation.job_version_id = job_version.id
    ORDER BY evaluation.evaluated_at DESC, evaluation.id DESC
    LIMIT 1
  ) AS ai_evaluation ON TRUE
  JOIN LATERAL (
    SELECT policy.policy_version, policy.minimum_ranking_confidence
    FROM ranking_policies AS policy
    WHERE policy.workspace_id = job.workspace_id
    ORDER BY policy.policy_version DESC
    LIMIT 1
  ) AS current_policy ON TRUE
  JOIN job_ranking_snapshots AS ranking
    ON ranking.workspace_id = job.workspace_id
   AND ranking.canonical_job_id = job.id
   AND ranking.job_version_id = job_version.id
   AND ranking.profile_version_id = active_profile.id
   AND ranking.match_run_id = match_run.id
   AND ranking.deterministic_decision_id = decision.id
   AND ranking.ai_evaluation_id = ai_evaluation.id
   AND ranking.ranking_policy_version = current_policy.policy_version
   AND ranking.context_fingerprint = ai_evaluation.context_fingerprint
  WHERE shortlist.gate_status = 'PASS'
    AND shortlist.current_artifact_status = 'CURRENT_OR_NOT_APPLICABLE'
    AND shortlist.version_mismatch = FALSE
    AND shortlist.primary_lane IS NOT NULL
    AND BTRIM(shortlist.primary_lane) <> ''
    AND job_version.content_hash = match_run.job_content_hash
    AND decision.recommendation_eligibility = shortlist.recommendation_eligibility
    AND decision.recommendation_outcome = shortlist.recommendation_outcome
    AND shortlist.recommendation_eligibility = 'ELIGIBLE'
    AND shortlist.recommendation_outcome IN ('PRIORITY', 'REVIEW')
    AND decision.recommendation_eligibility = 'ELIGIBLE'
    AND decision.recommendation_outcome IN ('PRIORITY', 'REVIEW')
    AND ai_evaluation.profile_version_id = active_profile.id
    AND ai_evaluation.match_run_id = match_run.id
    AND ai_evaluation.deterministic_decision_id = decision.id
    AND ai_evaluation.job_content_hash = job_version.content_hash
    AND ai_evaluation.context_fingerprint IS NOT NULL
    AND ai_evaluation.context_fingerprint = decision.context_fingerprint
    AND ranking.requirement_fit_score IS NOT NULL
    AND ranking.requirement_coverage_score IS NOT NULL
    AND ranking.evidence_completeness_score IS NOT NULL
    AND ranking.lane_confidence_score IS NOT NULL
    AND ranking.is_top_ten_ready = TRUE
    AND ranking.policy_recheck_required = FALSE
    AND NOT EXISTS (
      SELECT 1
      FROM policy_recheck_requests AS pending_recheck
      WHERE pending_recheck.workspace_id = job.workspace_id
        AND pending_recheck.canonical_job_id = job.id
        AND pending_recheck.job_version_id = job_version.id
        AND pending_recheck.ai_evaluation_id = ai_evaluation.id
        AND pending_recheck.context_fingerprint = decision.context_fingerprint
        AND pending_recheck.status = 'PENDING'
    )
    AND ranking.ranking_confidence >= current_policy.minimum_ranking_confidence
)
SELECT current_rankings.*
FROM current_rankings
WHERE current_rankings.ranking_position <= 10;

CREATE OR REPLACE VIEW v_application_workspace_scoped AS
SELECT
  application.id AS application_record_id,
  application.workspace_id,
  application.user_id,
  application.canonical_job_id,
  application.job_version_id,
  application.status AS application_status,
  application.submission_url,
  application.cv_document_run_id,
  application.cover_letter_document_run_id,
  application.notes,
  application.handoff_payload,
  application.target_submit_at,
  application.submitted_at,
  application.follow_up_at,
  application.last_action_at,
  application.created_at,
  application.updated_at,
  job.normalized_title AS title,
  job.company_name AS company,
  job.canonical_url,
  COALESCE(job.processing_state, job.processing_status) AS processing_state,
  job.recommendation_eligibility,
  job.recommendation_outcome,
  job.primary_lane,
  job.secondary_lanes,
  (job.latest_job_version_id = application.job_version_id) AS is_current_job_version,
  CASE
    WHEN application.cv_document_run_id IS NULL THEN 'NOT_GENERATED'
    WHEN cv_document.id IS NOT NULL
     AND job.latest_job_version_id = application.job_version_id
     AND job.latest_match_run_id = current_match.id
     AND job.latest_deterministic_decision_id = current_decision.id
     AND active_profile.id = cv_document.profile_version_id
     AND current_match.id = cv_document.match_run_id
     AND current_decision.id = cv_document.deterministic_decision_id
     AND current_decision.context_fingerprint = cv_document.context_fingerprint
     AND cv_document.status = 'COMPLETED' THEN 'READY'
    ELSE 'STALE'
  END AS cv_document_status,
  CASE
    WHEN application.cover_letter_document_run_id IS NULL THEN 'NOT_GENERATED'
    WHEN cover_letter_document.id IS NOT NULL
     AND job.latest_job_version_id = application.job_version_id
     AND job.latest_match_run_id = current_match.id
     AND job.latest_deterministic_decision_id = current_decision.id
     AND active_profile.id = cover_letter_document.profile_version_id
     AND current_match.id = cover_letter_document.match_run_id
     AND current_decision.id = cover_letter_document.deterministic_decision_id
     AND current_decision.context_fingerprint = cover_letter_document.context_fingerprint
     AND cover_letter_document.status = 'COMPLETED' THEN 'READY'
    ELSE 'STALE'
  END AS cover_letter_document_status
FROM application_records AS application
JOIN canonical_jobs AS job
  ON job.workspace_id = application.workspace_id
 AND job.id = application.canonical_job_id
JOIN job_versions AS job_version
  ON job_version.workspace_id = application.workspace_id
 AND job_version.canonical_job_id = application.canonical_job_id
 AND job_version.id = application.job_version_id
LEFT JOIN LATERAL (
  SELECT profile.id
  FROM profile_versions AS profile
  WHERE profile.workspace_id = job.workspace_id
    AND profile.status = 'ACTIVE'
  ORDER BY profile.created_at DESC, profile.id DESC
  LIMIT 1
) AS active_profile ON TRUE
LEFT JOIN match_runs AS current_match
  ON current_match.workspace_id = job.workspace_id
 AND current_match.id = job.latest_match_run_id
 AND current_match.canonical_job_id = job.id
 AND current_match.job_version_id = job.latest_job_version_id
 AND current_match.profile_version_id = active_profile.id
 AND current_match.status = 'COMPLETED'
LEFT JOIN deterministic_decisions AS current_decision
  ON current_decision.workspace_id = job.workspace_id
 AND current_decision.id = job.latest_deterministic_decision_id
 AND current_decision.canonical_job_id = job.id
 AND current_decision.job_version_id = job.latest_job_version_id
 AND current_decision.match_run_id = current_match.id
LEFT JOIN document_runs AS cv_document
  ON cv_document.workspace_id = application.workspace_id
 AND cv_document.id = application.cv_document_run_id
 AND cv_document.canonical_job_id = application.canonical_job_id
 AND cv_document.job_version_id = application.job_version_id
 AND cv_document.document_type = 'CV'
LEFT JOIN document_runs AS cover_letter_document
  ON cover_letter_document.workspace_id = application.workspace_id
 AND cover_letter_document.id = application.cover_letter_document_run_id
 AND cover_letter_document.canonical_job_id = application.canonical_job_id
 AND cover_letter_document.job_version_id = application.job_version_id
 AND cover_letter_document.document_type = 'COVER_LETTER';

CREATE OR REPLACE VIEW v_company_culture_analytics_scoped AS
WITH observation_aggregates AS (
  SELECT
    observation.workspace_id,
    observation.workspace_company_id,
    COUNT(*)::INTEGER AS observation_count,
    AVG(observation.autonomy_signal)::NUMERIC(5,2) AS autonomy_score,
    COUNT(observation.autonomy_signal)::INTEGER AS autonomy_observation_count,
    AVG(observation.politics_risk_signal)::NUMERIC(5,2) AS politics_risk_score,
    COUNT(observation.politics_risk_signal)::INTEGER AS politics_risk_observation_count,
    AVG(observation.sensory_workload_risk_signal)::NUMERIC(5,2) AS sensory_workload_risk_score,
    COUNT(observation.sensory_workload_risk_signal)::INTEGER AS sensory_workload_risk_observation_count,
    AVG(observation.strategic_value_signal)::NUMERIC(5,2) AS strategic_value_score,
    COUNT(observation.strategic_value_signal)::INTEGER AS strategic_value_observation_count,
    AVG(observation.focus_protection_signal)::NUMERIC(5,2) AS focus_protection_score,
    COUNT(observation.focus_protection_signal)::INTEGER AS focus_protection_observation_count,
    MAX(observation.observed_at) AS last_observed_at
  FROM company_culture_observations AS observation
  GROUP BY observation.workspace_id, observation.workspace_company_id
),
company_job_aggregates AS (
  SELECT
    company.workspace_id,
    company.id AS workspace_company_id,
    COUNT(job.id)::INTEGER AS company_job_count,
    MAX(job.updated_at) AS last_job_updated_at
  FROM workspace_companies AS company
  LEFT JOIN canonical_jobs AS job
    ON job.workspace_id = company.workspace_id
   AND LOWER(REGEXP_REPLACE(BTRIM(job.company_name), '[[:space:]]+', ' ', 'g'))
     = LOWER(REGEXP_REPLACE(BTRIM(company.normalized_company_name), '[[:space:]]+', ' ', 'g'))
   AND job.is_test_fixture = FALSE
   AND COALESCE(job.processing_state, job.processing_status) <> 'MANUALLY_REMOVED'
  GROUP BY company.workspace_id, company.id
)
SELECT
  company.workspace_id,
  company.id AS workspace_company_id,
  company.company_name,
  company.normalized_company_name,
  COALESCE(company_jobs.company_job_count, 0)::INTEGER AS company_job_count,
  COALESCE(aggregates.observation_count, 0)::INTEGER AS observation_count,
  aggregates.autonomy_score,
  COALESCE(aggregates.autonomy_score IS NOT NULL, FALSE) AS autonomy_score_available,
  aggregates.autonomy_observation_count,
  aggregates.politics_risk_score,
  COALESCE(aggregates.politics_risk_score IS NOT NULL, FALSE) AS politics_risk_score_available,
  aggregates.politics_risk_observation_count,
  aggregates.sensory_workload_risk_score,
  COALESCE(aggregates.sensory_workload_risk_score IS NOT NULL, FALSE) AS sensory_workload_risk_score_available,
  aggregates.sensory_workload_risk_observation_count,
  aggregates.strategic_value_score,
  COALESCE(aggregates.strategic_value_score IS NOT NULL, FALSE) AS strategic_value_score_available,
  aggregates.strategic_value_observation_count,
  aggregates.focus_protection_score,
  COALESCE(aggregates.focus_protection_score IS NOT NULL, FALSE) AS focus_protection_score_available,
  COALESCE(aggregates.focus_protection_observation_count, 0)::INTEGER AS focus_protection_observation_count,
  CASE WHEN aggregates.autonomy_score IS NULL THEN 'UNKNOWN' ELSE 'KNOWN' END AS autonomy_score_status,
  CASE WHEN aggregates.politics_risk_score IS NULL THEN 'UNKNOWN' ELSE 'KNOWN' END AS politics_risk_score_status,
  CASE WHEN aggregates.sensory_workload_risk_score IS NULL THEN 'UNKNOWN' ELSE 'KNOWN' END AS sensory_workload_risk_score_status,
  CASE WHEN aggregates.strategic_value_score IS NULL THEN 'UNKNOWN' ELSE 'KNOWN' END AS strategic_value_score_status,
  CASE WHEN aggregates.focus_protection_score IS NULL THEN 'UNKNOWN' ELSE 'KNOWN' END AS focus_protection_score_status,
  CASE
    WHEN COALESCE(aggregates.observation_count, 0) = 0 THEN 'UNKNOWN'
    WHEN aggregates.observation_count = 1 THEN 'LOW'
    WHEN aggregates.observation_count BETWEEN 2 AND 4 THEN 'MEDIUM'
    ELSE 'HIGH'
  END AS confidence_level,
  GREATEST(company.updated_at, aggregates.last_observed_at, company_jobs.last_job_updated_at) AS last_updated
FROM workspace_companies AS company
LEFT JOIN observation_aggregates AS aggregates
  ON aggregates.workspace_id = company.workspace_id
 AND aggregates.workspace_company_id = company.id
LEFT JOIN company_job_aggregates AS company_jobs
  ON company_jobs.workspace_id = company.workspace_id
 AND company_jobs.workspace_company_id = company.id;

CREATE OR REPLACE VIEW v_company_culture_evidence_scoped AS
SELECT
  observation.workspace_id,
  company.id AS workspace_company_id,
  company.company_name,
  observation.canonical_job_id,
  observation.job_version_id,
  job.normalized_title AS role_title,
  observation.ai_evaluation_id,
  observation.autonomy_signal,
  observation.politics_risk_signal,
  observation.sensory_workload_risk_signal,
  observation.focus_protection_signal,
  observation.strategic_value_signal,
  observation.evidence_by_signal,
  observation.source_type,
  observation.source_url,
  observation.evidence_quote,
  observation.evidence_hash,
  observation.observed_at
FROM company_culture_observations AS observation
JOIN workspace_companies AS company
  ON company.workspace_id = observation.workspace_id
 AND company.id = observation.workspace_company_id
JOIN canonical_jobs AS job
  ON job.workspace_id = observation.workspace_id
 AND job.id = observation.canonical_job_id
JOIN job_versions AS job_version
  ON job_version.workspace_id = observation.workspace_id
 AND job_version.canonical_job_id = observation.canonical_job_id
 AND job_version.id = observation.job_version_id
WHERE job.is_test_fixture = FALSE;

COMMENT ON TABLE ranking_policies IS
  'Immutable workspace ranking policy versions. Policy updates require inserting a new version.';
COMMENT ON TABLE job_ranking_snapshots IS
  'Append-only weighted ranking artifacts pinned to exact job, profile, match, decision, evaluation, policy, and context identities.';
COMMENT ON TABLE workspace_companies IS
  'Workspace-scoped company identity; unlike the legacy companies table, normalized names are unique only within each workspace.';
COMMENT ON TABLE company_culture_observations IS
  'Append-only, evidence-backed workplace culture observations with nullable signals and per-signal evidence attribution.';
COMMENT ON TABLE policy_recheck_requests IS
  'Auditable advisory AI conflict records; resolving a request does not mutate canonical gate or recommendation outcomes.';
COMMENT ON COLUMN company_culture_observations.evidence_by_signal IS
  'JSON object mapping each culture signal to its own AI evidence quote(s); kept separate from numeric signals and overall quote/hash provenance.';
COMMENT ON COLUMN company_culture_observations.autonomy_signal IS
  'Nullable 0–100 autonomy signal. NULL means unknown; no default score is inferred.';
COMMENT ON COLUMN company_culture_observations.politics_risk_signal IS
  'Nullable 0–100 politics-risk signal. NULL means unknown; no default score is inferred.';
COMMENT ON COLUMN company_culture_observations.sensory_workload_risk_signal IS
  'Nullable 0–100 sensory-workload-risk signal. NULL means unknown; no default score is inferred.';
COMMENT ON COLUMN company_culture_observations.strategic_value_signal IS
  'Nullable 0–100 strategic-value signal. NULL means unknown; no default score is inferred.';
COMMENT ON COLUMN company_culture_observations.focus_protection_signal IS
  'Nullable 0–100 focus-protection signal. NULL means unknown; no default score is inferred.';
COMMENT ON VIEW v_apply_now_jobs_scoped IS
  'Current PRIORITY/REVIEW jobs with deterministic ELIGIBLE and PASS gate; evaluation may be missing or stale only while deterministic context remains current. Exposes pending advisory rechecks without changing outcomes.';
COMMENT ON VIEW v_track_jobs_scoped IS
  'Current TRACK jobs with workspace-scoped deterministic decision id, context fingerprint, and trace notes from the canonical latest-decision pointer.';
COMMENT ON VIEW v_top_ten_ready_jobs_scoped IS
  'Top ten per workspace among rankings pinned to exact current artifacts, current policy, passing gate, assigned lane, and configured confidence threshold.';
COMMENT ON VIEW v_application_workspace_scoped IS
  'Workspace-scoped application records joined to their exact job version; historical application rows remain visible.';
COMMENT ON VIEW v_company_culture_analytics_scoped IS
  'Workspace-scoped culture averages from observations plus canonical job count and activity timestamp; absent scores remain NULL/UNKNOWN and confidence follows observation count.';
COMMENT ON VIEW v_company_culture_evidence_scoped IS
  'Workspace-scoped culture observations with per-signal job-description evidence, linked job version, AI evaluation, and immutable provenance.';

-- ============================================================================
-- 6) Profile evidence and coverage read models
-- ============================================================================

CREATE OR REPLACE VIEW v_job_profile_evidence_scoped AS
SELECT
  job.workspace_id,
  job.id AS canonical_job_id,
  job_version.id AS job_version_id,
  active_profile.id AS profile_version_id,
  match_run.id AS match_run_id,
  requirement.id AS requirement_id,
  requirement.requirement_key,
  requirement.requirement_type,
  requirement.importance,
  requirement.requirement_text,
  requirement.quote_text AS requirement_quote,
  evidence.match_type,
  evidence.match_score,
  profile_fact.id AS profile_fact_id,
  profile_fact.fact_type,
  profile_fact.statement AS profile_fact_statement,
  profile_fact.evidence_tier,
  profile_fact.verification_status AS fact_verification_status,
  engagement.id AS engagement_id,
  engagement.engagement_type,
  engagement.experience_class,
  engagement.role_title,
  CASE
    WHEN engagement.id IS NOT NULL THEN profile_fact.statement
    ELSE NULL
  END AS engagement_evidence,
  engagement.verification_status AS engagement_verification_status,
  CASE
    WHEN profile_fact.fact_type = 'PROJECT' THEN profile_fact.statement
    ELSE NULL
  END AS project_evidence
FROM canonical_jobs AS job
JOIN job_versions AS job_version
  ON job_version.workspace_id = job.workspace_id
 AND job_version.canonical_job_id = job.id
 AND job_version.id = job.latest_job_version_id
JOIN LATERAL (
  SELECT profile.id
  FROM profile_versions AS profile
  WHERE profile.workspace_id = job.workspace_id
    AND profile.status = 'ACTIVE'
  ORDER BY profile.created_at DESC, profile.id DESC
  LIMIT 1
) AS active_profile ON TRUE
JOIN match_runs AS match_run
  ON match_run.workspace_id = job.workspace_id
 AND match_run.id = job.latest_match_run_id
 AND match_run.canonical_job_id = job.id
 AND match_run.job_version_id = job_version.id
 AND match_run.profile_version_id = active_profile.id
 AND match_run.status = 'COMPLETED'
 AND job_version.active_requirement_set_id IS NOT NULL
 AND match_run.requirement_set_id = job_version.active_requirement_set_id
 AND match_run.job_content_hash = job_version.content_hash
 AND match_run.context_fingerprint IS NOT NULL
JOIN job_requirements AS requirement
  ON requirement.workspace_id = job.workspace_id
 AND requirement.canonical_job_id = job.id
 AND requirement.job_version_id = job_version.id
 AND requirement.requirement_set_id = job_version.active_requirement_set_id
 AND requirement.status IN ('EXTRACTED', 'VALIDATED')
LEFT JOIN requirement_evidence_matches AS evidence
  ON evidence.workspace_id = job.workspace_id
 AND evidence.match_run_id = match_run.id
 AND evidence.requirement_id = requirement.id
LEFT JOIN profile_facts AS profile_fact
  ON profile_fact.workspace_id = job.workspace_id
 AND profile_fact.id = evidence.profile_fact_id
 AND profile_fact.profile_version_id = active_profile.id
 AND profile_fact.confidentiality <> 'PRIVATE_INTERNAL'
LEFT JOIN profile_engagements AS engagement
  ON engagement.workspace_id = job.workspace_id
 AND engagement.id = profile_fact.engagement_id
 AND engagement.profile_version_id = active_profile.id
WHERE job.is_test_fixture = FALSE;

CREATE OR REPLACE VIEW v_profile_coverage_scoped AS
WITH active_match_contexts AS (
  SELECT
    job.workspace_id,
    job.id AS canonical_job_id,
    job_version.id AS job_version_id,
    job_version.active_requirement_set_id AS requirement_set_id,
    active_profile.id AS profile_version_id,
    active_profile.version_number AS profile_version_number,
    match_run.id AS match_run_id
  FROM canonical_jobs AS job
  JOIN job_versions AS job_version
    ON job_version.workspace_id = job.workspace_id
   AND job_version.canonical_job_id = job.id
   AND job_version.id = job.latest_job_version_id
  JOIN LATERAL (
    SELECT profile.id, profile.version_number
    FROM profile_versions AS profile
    WHERE profile.workspace_id = job.workspace_id
      AND profile.status = 'ACTIVE'
    ORDER BY profile.created_at DESC, profile.id DESC
    LIMIT 1
  ) AS active_profile ON TRUE
  JOIN match_runs AS match_run
    ON match_run.workspace_id = job.workspace_id
   AND match_run.id = job.latest_match_run_id
   AND match_run.canonical_job_id = job.id
   AND match_run.job_version_id = job_version.id
   AND match_run.profile_version_id = active_profile.id
   AND match_run.status = 'COMPLETED'
   AND job_version.active_requirement_set_id IS NOT NULL
   AND match_run.requirement_set_id = job_version.active_requirement_set_id
   AND match_run.job_content_hash = job_version.content_hash
   AND match_run.context_fingerprint IS NOT NULL
  WHERE job.is_test_fixture = FALSE
),
requirement_coverage AS (
  SELECT
    context.workspace_id,
    context.canonical_job_id,
    context.job_version_id,
    context.profile_version_id,
    context.match_run_id,
    COUNT(evidence.id) FILTER (WHERE evidence.match_type = 'EXACT')::INTEGER AS exact_match_count,
    COUNT(evidence.id) FILTER (WHERE evidence.match_type = 'SEMANTIC')::INTEGER AS semantic_match_count,
    COUNT(requirement.id) FILTER (WHERE requirement.importance = 'MUST' AND evidence.match_type = 'EXACT')::INTEGER AS must_exact_matched_count,
    COUNT(requirement.id) FILTER (WHERE requirement.importance = 'MUST' AND evidence.match_type = 'SEMANTIC')::INTEGER AS must_semantic_matched_count,
    COUNT(requirement.id) FILTER (WHERE requirement.importance = 'PREFERRED' AND evidence.match_type = 'EXACT')::INTEGER AS preferred_exact_matched_count,
    COUNT(requirement.id) FILTER (WHERE requirement.importance = 'PREFERRED' AND evidence.match_type = 'SEMANTIC')::INTEGER AS preferred_semantic_matched_count,
    COUNT(requirement.id) FILTER (WHERE requirement.importance = 'MUST')::INTEGER AS must_requirement_count,
    COUNT(requirement.id) FILTER (
      WHERE requirement.importance = 'MUST'
        AND evidence.match_type IN ('EXACT', 'SEMANTIC')
    )::INTEGER AS must_matched_count,
    COUNT(requirement.id) FILTER (
      WHERE requirement.importance = 'MUST'
        AND (evidence.match_type IS NULL OR evidence.match_type NOT IN ('EXACT', 'SEMANTIC'))
    )::INTEGER AS must_missing_count,
    COUNT(requirement.id) FILTER (WHERE requirement.importance = 'PREFERRED')::INTEGER AS preferred_requirement_count,
    COUNT(requirement.id) FILTER (
      WHERE requirement.importance = 'PREFERRED'
        AND evidence.match_type IN ('EXACT', 'SEMANTIC')
    )::INTEGER AS preferred_matched_count,
    COUNT(requirement.id) FILTER (
      WHERE requirement.importance = 'PREFERRED'
        AND (evidence.match_type IS NULL OR evidence.match_type NOT IN ('EXACT', 'SEMANTIC'))
    )::INTEGER AS preferred_missing_count
  FROM active_match_contexts AS context
  JOIN job_requirements AS requirement
    ON requirement.workspace_id = context.workspace_id
   AND requirement.canonical_job_id = context.canonical_job_id
   AND requirement.job_version_id = context.job_version_id
   AND requirement.requirement_set_id = context.requirement_set_id
   AND requirement.status IN ('EXTRACTED', 'VALIDATED')
  LEFT JOIN requirement_evidence_matches AS evidence
    ON evidence.workspace_id = context.workspace_id
   AND evidence.match_run_id = context.match_run_id
   AND evidence.requirement_id = requirement.id
  GROUP BY
    context.workspace_id,
    context.canonical_job_id,
    context.job_version_id,
    context.profile_version_id,
    context.match_run_id
),
profile_evidence_tier_counts AS (
  SELECT
    fact.workspace_id,
    fact.profile_version_id,
    COUNT(*)::INTEGER AS profile_fact_count,
    COUNT(*) FILTER (WHERE fact.fact_type = 'ACHIEVEMENT')::INTEGER AS achievement_count,
    COUNT(*) FILTER (WHERE fact.fact_type = 'RESPONSIBILITY')::INTEGER AS responsibility_count,
    COUNT(*) FILTER (WHERE fact.fact_type = 'PROJECT')::INTEGER AS project_count,
    COUNT(*) FILTER (WHERE fact.fact_type = 'SKILL')::INTEGER AS skill_count,
    COUNT(*) FILTER (WHERE fact.fact_type = 'TECHNOLOGY')::INTEGER AS technology_count,
    COUNT(*) FILTER (WHERE fact.fact_type = 'DOMAIN')::INTEGER AS domain_count,
    COUNT(*) FILTER (WHERE fact.fact_type = 'PUBLICATION')::INTEGER AS publication_count,
    COUNT(*) FILTER (WHERE fact.fact_type = 'OPEN_SOURCE')::INTEGER AS open_source_count,
    COUNT(*) FILTER (WHERE fact.evidence_tier = 'PROFESSIONAL_PRODUCTION')::INTEGER AS professional_production_evidence_count,
    COUNT(*) FILTER (WHERE fact.evidence_tier = 'DEPLOYED_OPEN_SOURCE')::INTEGER AS deployed_open_source_evidence_count,
    COUNT(*) FILTER (WHERE fact.evidence_tier = 'APPLIED_PROJECT')::INTEGER AS applied_project_evidence_count,
    COUNT(*) FILTER (WHERE fact.evidence_tier = 'COURSE_PROJECT')::INTEGER AS course_project_evidence_count,
    COUNT(*) FILTER (WHERE fact.evidence_tier = 'KNOWLEDGE_ONLY')::INTEGER AS knowledge_only_evidence_count
  FROM profile_facts AS fact
  WHERE fact.confidentiality <> 'PRIVATE_INTERNAL'
  GROUP BY fact.workspace_id, fact.profile_version_id
),
profile_credential_counts AS (
  SELECT
    credential.workspace_id,
    credential.profile_version_id,
    COUNT(*) FILTER (WHERE credential.status = 'ACTIVE')::INTEGER AS active_credential_count
  FROM profile_credentials AS credential
  GROUP BY credential.workspace_id, credential.profile_version_id
),
profile_engagement_counts AS (
  SELECT
    engagement.workspace_id,
    engagement.profile_version_id,
    COUNT(*)::INTEGER AS engagement_count
  FROM profile_engagements AS engagement
  GROUP BY engagement.workspace_id, engagement.profile_version_id
)
SELECT
  context.workspace_id,
  context.canonical_job_id,
  context.job_version_id,
  context.profile_version_id,
  context.profile_version_number,
  context.match_run_id,
  COALESCE(coverage.exact_match_count, 0)::INTEGER AS exact_match_count,
  COALESCE(coverage.semantic_match_count, 0)::INTEGER AS semantic_match_count,
  COALESCE(coverage.must_exact_matched_count, 0)::INTEGER AS must_exact_matched_count,
  COALESCE(coverage.must_semantic_matched_count, 0)::INTEGER AS must_semantic_matched_count,
  COALESCE(coverage.preferred_exact_matched_count, 0)::INTEGER AS preferred_exact_matched_count,
  COALESCE(coverage.preferred_semantic_matched_count, 0)::INTEGER AS preferred_semantic_matched_count,
  COALESCE(coverage.must_requirement_count, 0)::INTEGER AS must_requirement_count,
  COALESCE(coverage.must_matched_count, 0)::INTEGER AS must_matched_count,
  COALESCE(coverage.must_missing_count, 0)::INTEGER AS must_missing_count,
  COALESCE(coverage.preferred_requirement_count, 0)::INTEGER AS preferred_requirement_count,
  COALESCE(coverage.preferred_matched_count, 0)::INTEGER AS preferred_matched_count,
  COALESCE(coverage.preferred_missing_count, 0)::INTEGER AS preferred_missing_count,
  COALESCE(tiers.professional_production_evidence_count, 0)::INTEGER AS professional_production_evidence_count,
  COALESCE(tiers.deployed_open_source_evidence_count, 0)::INTEGER AS deployed_open_source_evidence_count,
  COALESCE(tiers.applied_project_evidence_count, 0)::INTEGER AS applied_project_evidence_count,
  COALESCE(tiers.course_project_evidence_count, 0)::INTEGER AS course_project_evidence_count,
  COALESCE(tiers.knowledge_only_evidence_count, 0)::INTEGER AS knowledge_only_evidence_count,
  COALESCE(tiers.profile_fact_count, 0)::INTEGER AS profile_fact_count,
  COALESCE(tiers.achievement_count, 0)::INTEGER AS achievement_count,
  COALESCE(tiers.responsibility_count, 0)::INTEGER AS responsibility_count,
  COALESCE(tiers.project_count, 0)::INTEGER AS project_count,
  COALESCE(tiers.skill_count, 0)::INTEGER AS skill_count,
  COALESCE(tiers.technology_count, 0)::INTEGER AS technology_count,
  COALESCE(tiers.domain_count, 0)::INTEGER AS domain_count,
  COALESCE(tiers.publication_count, 0)::INTEGER AS publication_count,
  COALESCE(tiers.open_source_count, 0)::INTEGER AS open_source_count,
  COALESCE(credentials.active_credential_count, 0)::INTEGER AS active_credential_count,
  COALESCE(engagements.engagement_count, 0)::INTEGER AS engagement_count
FROM active_match_contexts AS context
LEFT JOIN requirement_coverage AS coverage
  ON coverage.workspace_id = context.workspace_id
 AND coverage.canonical_job_id = context.canonical_job_id
 AND coverage.job_version_id = context.job_version_id
 AND coverage.profile_version_id = context.profile_version_id
 AND coverage.match_run_id = context.match_run_id
LEFT JOIN profile_evidence_tier_counts AS tiers
  ON tiers.workspace_id = context.workspace_id
 AND tiers.profile_version_id = context.profile_version_id
LEFT JOIN profile_credential_counts AS credentials
  ON credentials.workspace_id = context.workspace_id
 AND credentials.profile_version_id = context.profile_version_id
LEFT JOIN profile_engagement_counts AS engagements
  ON engagements.workspace_id = context.workspace_id
 AND engagements.profile_version_id = context.profile_version_id;

COMMENT ON VIEW v_job_profile_evidence_scoped IS
  'Current job-version and match evidence only. Exposes only matched non-PRIVATE_INTERNAL facts and linked engagement/project evidence; excludes contact details and unrelated profile fields.';
COMMENT ON VIEW v_profile_coverage_scoped IS
  'Per-current-job active-profile coverage with exact/semantic match counts, MUST/PREFERRED matched/missing counts, and aggregate evidence-tier counts.';

-- ============================================================================
-- 7) Authoritative workspace application summary
-- ============================================================================

CREATE OR REPLACE VIEW v_application_workspace_summary_scoped AS
WITH current_job_rows AS (
  SELECT
    shortlist.workspace_id,
    shortlist.canonical_job_id,
    (shortlist.pipeline_display_category = 'PROCESSING_AUTOMATICALLY') AS is_processing,
    (shortlist.pipeline_display_category = 'REJECTED_UNMATCHED') AS is_rejected_unmatched
  FROM v_canonical_shortlist_actions_scoped AS shortlist
  UNION ALL
  SELECT
    rejected.workspace_id,
    rejected.id AS canonical_job_id,
    FALSE AS is_processing,
    TRUE AS is_rejected_unmatched
  FROM v_rejected_jobs_audit_scoped AS rejected
),
operational_jobs AS (
  SELECT
    workspace_id,
    canonical_job_id,
    BOOL_OR(is_processing) AS is_processing,
    BOOL_OR(is_rejected_unmatched) AS is_rejected_unmatched
  FROM current_job_rows
  GROUP BY workspace_id, canonical_job_id
),
pipeline_counts AS (
  SELECT
    workspace_id,
    COUNT(*)::INTEGER AS total_jobs,
    COUNT(*) FILTER (WHERE is_processing)::INTEGER AS processing_count,
    COUNT(*) FILTER (WHERE is_rejected_unmatched)::INTEGER AS rejected_unmatched_count
  FROM operational_jobs
  GROUP BY workspace_id
),
apply_now_counts AS (
  SELECT workspace_id, COUNT(DISTINCT canonical_job_id)::INTEGER AS apply_now_count
  FROM v_apply_now_jobs_scoped
  GROUP BY workspace_id
),
track_counts AS (
  SELECT workspace_id, COUNT(DISTINCT canonical_job_id)::INTEGER AS track_count
  FROM v_track_jobs_scoped
  GROUP BY workspace_id
),
skip_counts AS (
  SELECT
    workspace_id,
    COUNT(DISTINCT canonical_job_id) FILTER (WHERE recommendation_outcome = 'SKIP')::INTEGER AS skip_count
  FROM v_canonical_shortlist_actions_scoped
  GROUP BY workspace_id
),
top_ten_counts AS (
  SELECT workspace_id, COUNT(DISTINCT canonical_job_id)::INTEGER AS top_ten_ready_count
  FROM v_top_ten_ready_jobs_scoped
  GROUP BY workspace_id
),
technical_error_counts AS (
  SELECT
    shortlist.workspace_id,
    SUM(GREATEST(
      COALESCE(shortlist.technical_error_count, 0),
      CASE WHEN shortlist.processing_state = 'PROCESSING_ERROR' THEN 1 ELSE 0 END
    ))::INTEGER AS technical_errors
  FROM v_canonical_shortlist_actions_scoped AS shortlist
  GROUP BY shortlist.workspace_id
),
application_counts AS (
  SELECT
    application.workspace_id,
    application.user_id,
    COUNT(*) FILTER (WHERE application.status IN (
      'APPLIED', 'ASSESSMENT', 'SUBMITTED', 'FOLLOW_UP', 'INTERVIEW',
      'OFFER', 'REJECTED', 'WITHDRAWN'
    ))::INTEGER AS applied_count
  FROM application_records AS application
  GROUP BY application.workspace_id, application.user_id
)
SELECT
  workspace.id AS workspace_id,
  membership.user_id,
  workspace_user.user_key,
  COALESCE(pipeline.total_jobs, 0)::INTEGER AS total_jobs,
  COALESCE(apply_now.apply_now_count, 0)::INTEGER AS apply_now_count,
  COALESCE(track.track_count, 0)::INTEGER AS track_count,
  COALESCE(pipeline.processing_count, 0)::INTEGER AS processing_count,
  COALESCE(pipeline.rejected_unmatched_count, 0)::INTEGER AS rejected_unmatched_count,
  COALESCE(applications.applied_count, 0)::INTEGER AS applied_count,
  COALESCE(errors.technical_errors, 0)::INTEGER AS technical_errors,
  COALESCE(skips.skip_count, 0)::INTEGER AS skip_count,
  COALESCE(top_ten.top_ten_ready_count, 0)::INTEGER AS top_ten_ready_count
FROM workspaces AS workspace
JOIN workspace_memberships AS membership
  ON membership.workspace_id = workspace.id
 AND membership.status = 'ACTIVE'
JOIN workspace_users AS workspace_user
  ON workspace_user.id = membership.user_id
LEFT JOIN pipeline_counts AS pipeline
  ON pipeline.workspace_id = workspace.id
LEFT JOIN apply_now_counts AS apply_now
  ON apply_now.workspace_id = workspace.id
LEFT JOIN track_counts AS track
  ON track.workspace_id = workspace.id
LEFT JOIN skip_counts AS skips
  ON skips.workspace_id = workspace.id
LEFT JOIN technical_error_counts AS errors
  ON errors.workspace_id = workspace.id
LEFT JOIN top_ten_counts AS top_ten
  ON top_ten.workspace_id = workspace.id
LEFT JOIN application_counts AS applications
  ON applications.workspace_id = workspace.id
 AND applications.user_id = membership.user_id;

COMMENT ON VIEW v_application_workspace_summary_scoped IS
  'Authoritative, unpaginated workspace summary; pipeline metrics use current scoped read models and each active workspace member receives a user_id/user_key-scoped application count row.';
