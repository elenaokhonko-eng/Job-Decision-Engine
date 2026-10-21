-- Migration 076: lower the minimum ranking confidence for Top 10 readiness to 90%.
-- Preserve historical immutable policies and snapshots; append a new policy version
-- for each workspace still on the existing 95% default threshold.

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
    90.00
  )
  ON CONFLICT (workspace_id, policy_version) DO NOTHING;
  RETURN NEW;
END;
$$;

ALTER TABLE ranking_policies
  ALTER COLUMN minimum_ranking_confidence SET DEFAULT 90.00;

INSERT INTO ranking_policies (
  workspace_id,
  policy_version,
  schema_version,
  weights,
  minimum_ranking_confidence
)
SELECT
  workspace.id,
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
  90.00
FROM workspaces AS workspace
WHERE NOT EXISTS (
  SELECT 1
  FROM ranking_policies AS existing_policy
  WHERE existing_policy.workspace_id = workspace.id
)
ON CONFLICT (workspace_id, policy_version) DO NOTHING;

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
  latest_policy.weights,
  90.00
FROM latest_policy
WHERE latest_policy.minimum_ranking_confidence = 95.00
ON CONFLICT (workspace_id, policy_version) DO NOTHING;

COMMENT ON COLUMN ranking_policies.minimum_ranking_confidence IS
  'Minimum percentage confidence for Top 10 readiness; default policy threshold is 90.00.';
