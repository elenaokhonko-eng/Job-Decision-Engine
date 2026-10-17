-- Migration 070: expose only culture observations whose scores were derived from verified quotes.
--
-- Existing AI-proposed observations are preserved in storage but excluded from V5 culture
-- analytics. New evaluations are re-materialized by the validated trigger below.

CREATE OR REPLACE FUNCTION materialize_v5_validated_culture_observation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_context RECORD;
  workspace_company_id UUID;
  evidence_by_signal JSONB;
  evidence_summary TEXT;
  autonomy_score NUMERIC(5,2);
  politics_risk_score NUMERIC(5,2);
  sensory_workload_risk_score NUMERIC(5,2);
  focus_protection_score NUMERIC(5,2);
BEGIN
  IF NEW.full_evaluation_payload IS NULL
     OR NEW.context_fingerprint IS NULL
     OR NEW.profile_version_id IS NULL
     OR NEW.match_run_id IS NULL
     OR NEW.deterministic_decision_id IS NULL
     OR NEW.full_evaluation_payload ->> 'culture_score_derivation_version' IS DISTINCT FROM 'quote_phrase_rules_v1' THEN
    RETURN NEW;
  END IF;

  SELECT
    job.workspace_id,
    job.id AS canonical_job_id,
    job.company_name,
    job.canonical_url,
    job_version.id AS job_version_id,
    job_version.content_hash,
    job_version.description_text,
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
   AND job_version.id = NEW.job_version_id
   AND job_version.active_requirement_set_id IS NOT NULL
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
   AND match_run.id = NEW.match_run_id
   AND match_run.canonical_job_id = job.id
   AND match_run.job_version_id = job_version.id
   AND match_run.profile_version_id = active_profile.id
   AND match_run.requirement_set_id = job_version.active_requirement_set_id
   AND match_run.job_content_hash = job_version.content_hash
   AND match_run.status = 'COMPLETED'
  JOIN deterministic_decisions AS decision
    ON decision.workspace_id = job.workspace_id
   AND decision.id = job.latest_deterministic_decision_id
   AND decision.id = NEW.deterministic_decision_id
   AND decision.canonical_job_id = job.id
   AND decision.job_version_id = job_version.id
   AND decision.match_run_id = match_run.id
   AND decision.context_fingerprint = NEW.context_fingerprint
  WHERE job.workspace_id = NEW.workspace_id
    AND job.id = NEW.canonical_job_id
    AND active_profile.id = NEW.profile_version_id
    AND match_run.context_fingerprint IS NOT NULL
    AND match_run.job_content_hash = job_version.content_hash
    AND NEW.job_content_hash = job_version.content_hash
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
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

  WITH raw_signals AS (
    SELECT signal.value
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(NEW.full_evaluation_payload -> 'culture_evidence') = 'array'
          THEN NEW.full_evaluation_payload -> 'culture_evidence'
        ELSE '[]'::JSONB
      END
    ) AS signal(value)
    WHERE signal.value ->> 'score_derivation_version' = 'quote_phrase_rules_v1'
      AND signal.value ->> 'signal' IN (
        'AUTONOMY', 'POLITICS_RISK', 'SENSORY_WORKLOAD_RISK', 'FOCUS_PROTECTION'
      )
  ),
  verified_signals AS (
    SELECT
      value ->> 'signal' AS signal,
      CASE
        WHEN jsonb_typeof(value -> 'score') = 'number'
         AND NULLIF(value ->> 'quote', '') IS NOT NULL
         AND POSITION(value ->> 'quote' IN current_context.description_text) > 0
         AND (value ->> 'score')::NUMERIC BETWEEN 0 AND 100
          THEN (value ->> 'score')::NUMERIC
        ELSE NULL
      END AS score,
      CASE
        WHEN jsonb_typeof(value -> 'score') = 'number'
         AND NULLIF(value ->> 'quote', '') IS NOT NULL
         AND POSITION(value ->> 'quote' IN current_context.description_text) > 0
         AND (value ->> 'score')::NUMERIC BETWEEN 0 AND 100
          THEN value ->> 'quote'
        ELSE NULL
      END AS quote
    FROM raw_signals
  )
  SELECT
    COALESCE(
      JSONB_OBJECT_AGG(
        signal,
        JSONB_BUILD_OBJECT(
          'score', score,
          'quote', quote,
          'score_derivation_version', 'quote_phrase_rules_v1'
        )
      ),
      '{}'::JSONB
    ),
    STRING_AGG(quote, E'\n' ORDER BY signal) FILTER (WHERE score IS NOT NULL),
    MAX(score) FILTER (WHERE signal = 'AUTONOMY'),
    MAX(score) FILTER (WHERE signal = 'POLITICS_RISK'),
    MAX(score) FILTER (WHERE signal = 'SENSORY_WORKLOAD_RISK'),
    MAX(score) FILTER (WHERE signal = 'FOCUS_PROTECTION')
  INTO
    evidence_by_signal,
    evidence_summary,
    autonomy_score,
    politics_risk_score,
    sensory_workload_risk_score,
    focus_protection_score
  FROM verified_signals;

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
    NEW.workspace_id,
    workspace_company_id,
    NEW.canonical_job_id,
    NEW.job_version_id,
    NEW.id,
    autonomy_score,
    politics_risk_score,
    sensory_workload_risk_score,
    focus_protection_score,
    NULL,
    'DETERMINISTIC_QUOTE_RULES_V1',
    current_context.canonical_url,
    evidence_summary,
    MD5(NEW.full_evaluation_payload::TEXT || NEW.context_fingerprint),
    evidence_by_signal
  )
  ON CONFLICT (workspace_id, ai_evaluation_id)
  DO UPDATE SET
    autonomy_signal = EXCLUDED.autonomy_signal,
    politics_risk_signal = EXCLUDED.politics_risk_signal,
    sensory_workload_risk_signal = EXCLUDED.sensory_workload_risk_signal,
    focus_protection_signal = EXCLUDED.focus_protection_signal,
    strategic_value_signal = NULL,
    source_type = EXCLUDED.source_type,
    source_url = EXCLUDED.source_url,
    evidence_quote = EXCLUDED.evidence_quote,
    evidence_hash = EXCLUDED.evidence_hash,
    evidence_by_signal = EXCLUDED.evidence_by_signal,
    observed_at = NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_z_ai_evaluations_validated_culture_observation ON ai_evaluations;
CREATE TRIGGER trg_z_ai_evaluations_validated_culture_observation
AFTER INSERT ON ai_evaluations
FOR EACH ROW EXECUTE FUNCTION materialize_v5_validated_culture_observation();

WITH latest_policy AS (
  SELECT DISTINCT ON (policy.workspace_id)
    policy.workspace_id,
    policy.policy_version,
    policy.weights,
    policy.minimum_ranking_confidence
  FROM ranking_policies AS policy
  ORDER BY policy.workspace_id, policy.policy_version DESC
)
INSERT INTO ranking_policies (
  workspace_id,
  policy_version,
  schema_version,
  weights,
  minimum_ranking_confidence
)
SELECT
  latest_policy.workspace_id,
  latest_policy.policy_version + 1,
  '5.1.0',
  latest_policy.weights,
  latest_policy.minimum_ranking_confidence
FROM latest_policy
WHERE NOT EXISTS (
  SELECT 1
  FROM ranking_policies AS versioned_policy
  WHERE versioned_policy.workspace_id = latest_policy.workspace_id
    AND versioned_policy.schema_version = '5.1.0'
)
ON CONFLICT (workspace_id, policy_version) DO NOTHING;

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
  WHERE observation.source_type = 'DETERMINISTIC_QUOTE_RULES_V1'
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
WHERE job.is_test_fixture = FALSE
  AND observation.source_type = 'DETERMINISTIC_QUOTE_RULES_V1';

COMMENT ON VIEW v_company_culture_analytics_scoped IS
  'Company culture analytics include only current evaluation observations scored by deterministic exact-quote rules; historical model-proposed numeric signals remain stored but are not surfaced.';
COMMENT ON VIEW v_company_culture_evidence_scoped IS
  'Company culture evidence includes only current evaluation observations scored by deterministic exact-quote rules.';
