-- Migration 074: keep the 95% Top 10 confidence gate reachable with unknown strategic value.
--
-- Strategic value remains unknown unless independently supported. Cap its optional
-- policy weight at 5%, moving any excess weight to deterministic requirement fit.
-- Recommendation eligibility thresholds and outcomes are unchanged.

CREATE OR REPLACE FUNCTION seed_default_ranking_policy_for_workspace()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO ranking_policies (
    workspace_id,
    policy_version,
    schema_version,
    weights,
    minimum_ranking_confidence
  ) VALUES (
    NEW.id,
    1,
    '5.2.0',
    '{
      "requirementFit": 37.5,
      "requirementCoverage": 15,
      "evidenceCompleteness": 10,
      "laneConfidence": 10,
      "autonomy": 10,
      "politicsRisk": 7.5,
      "sensoryWorkloadRisk": 5,
      "strategicValue": 5
    }'::JSONB,
    95.00
  )
  ON CONFLICT (workspace_id, policy_version) DO NOTHING;
  RETURN NEW;
END;
$$;

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
  '5.2.0',
  CASE
    WHEN (latest_policy.weights ->> 'strategicValue')::NUMERIC > 5 THEN
      JSONB_SET(
        JSONB_SET(
          latest_policy.weights,
          '{requirementFit}',
          TO_JSONB(
            (latest_policy.weights ->> 'requirementFit')::NUMERIC
            + (latest_policy.weights ->> 'strategicValue')::NUMERIC - 5
          )
        ),
        '{strategicValue}',
        TO_JSONB(5.0)
      )
    ELSE latest_policy.weights
  END,
  latest_policy.minimum_ranking_confidence
FROM latest_policy
WHERE NOT EXISTS (
  SELECT 1
  FROM ranking_policies AS versioned_policy
  WHERE versioned_policy.workspace_id = latest_policy.workspace_id
    AND versioned_policy.schema_version = '5.2.0'
)
ON CONFLICT (workspace_id, policy_version) DO NOTHING;
