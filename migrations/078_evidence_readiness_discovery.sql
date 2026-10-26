-- Migration 078: immutable source evidence, readiness lineage, FX observations, and discovery dispositions.
--
-- All evidence and decision fields are nullable for legacy compatibility. Missing historical
-- evidence remains UNKNOWN; no source date, availability state, salary, or readiness is backfilled.
-- The old posting-identity index is replaced because a source posting can publish multiple
-- immutable content versions. Raw observations, job versions, decisions, and document history remain.
--
-- Recovery: restore the previous posting-identity index only after proving no posting has multiple
-- content versions. All new ledgers are append-only; application rollback can stop writing them.

ALTER TABLE raw_job_observations
  ADD COLUMN IF NOT EXISTS normalized_evidence JSONB,
  ADD COLUMN IF NOT EXISTS evidence_schema_version TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'raw_job_observations'
      AND constraint_name = 'raw_job_observations_normalized_evidence_chk'
  ) THEN
    ALTER TABLE raw_job_observations
      ADD CONSTRAINT raw_job_observations_normalized_evidence_chk
      CHECK (
        (normalized_evidence IS NULL AND evidence_schema_version IS NULL)
        OR (
          jsonb_typeof(normalized_evidence) = 'object'
          AND evidence_schema_version = 'job_source_evidence_v1'
          AND normalized_evidence->>'schema_version' = evidence_schema_version
        )
      );
  END IF;
END;
$$;

ALTER TABLE job_versions
  ADD COLUMN IF NOT EXISTS availability_status TEXT,
  ADD COLUMN IF NOT EXISTS availability_evidence JSONB,
  ADD COLUMN IF NOT EXISTS availability_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS availability_recheck_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS evidence_revision_hash TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_versions'
      AND constraint_name = 'job_versions_availability_status_chk'
  ) THEN
    ALTER TABLE job_versions
      ADD CONSTRAINT job_versions_availability_status_chk
      CHECK (availability_status IS NULL OR availability_status IN ('OPEN', 'CLOSED', 'UNKNOWN'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_versions'
      AND constraint_name = 'job_versions_evidence_revision_hash_chk'
  ) THEN
    ALTER TABLE job_versions
      ADD CONSTRAINT job_versions_evidence_revision_hash_chk
      CHECK (evidence_revision_hash IS NULL OR evidence_revision_hash ~ '^[a-f0-9]{64}$');
  END IF;
END;
$$;

COMMENT ON COLUMN job_versions.availability_status IS
  'Evidence-backed OPEN/CLOSED state; NULL means not yet verified, never inferred from ingestion.';
COMMENT ON COLUMN job_versions.availability_evidence IS
  'Versioned source/provenance record supporting the latest availability assessment.';
COMMENT ON COLUMN job_versions.availability_recheck_at IS
  'Time after which availability evidence must be rechecked before application readiness.';
COMMENT ON COLUMN job_versions.evidence_revision_hash IS
  'SHA-256 digest of normalized source evidence; changes invalidate dependent decisions and rankings.';

ALTER TABLE deterministic_decisions
  ADD COLUMN IF NOT EXISTS readiness_json JSONB,
  ADD COLUMN IF NOT EXISTS evidence_revision_hash TEXT,
  ADD COLUMN IF NOT EXISTS readiness_fingerprint TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'deterministic_decisions'
      AND constraint_name = 'deterministic_decisions_readiness_json_chk'
  ) THEN
    ALTER TABLE deterministic_decisions
      ADD CONSTRAINT deterministic_decisions_readiness_json_chk
      CHECK (
        readiness_json IS NULL
        OR (
          jsonb_typeof(readiness_json) = 'object'
          AND readiness_json->>'schema_version' = 'application_readiness_v1'
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'deterministic_decisions'
      AND constraint_name = 'deterministic_decisions_evidence_hash_chk'
  ) THEN
    ALTER TABLE deterministic_decisions
      ADD CONSTRAINT deterministic_decisions_evidence_hash_chk
      CHECK (evidence_revision_hash IS NULL OR evidence_revision_hash ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'deterministic_decisions'
      AND constraint_name = 'deterministic_decisions_readiness_fingerprint_chk'
  ) THEN
    ALTER TABLE deterministic_decisions
      ADD CONSTRAINT deterministic_decisions_readiness_fingerprint_chk
      CHECK (readiness_fingerprint IS NULL OR readiness_fingerprint ~ '^[a-f0-9]{64}$');
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_deterministic_decisions_readiness_fingerprint
  ON deterministic_decisions (workspace_id, readiness_fingerprint)
  WHERE readiness_fingerprint IS NOT NULL;

ALTER TABLE job_ranking_snapshots
  ADD COLUMN IF NOT EXISTS culture_priority_score NUMERIC(5,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_ranking_snapshots'
      AND constraint_name = 'job_ranking_snapshots_culture_priority_score_chk'
  ) THEN
    ALTER TABLE job_ranking_snapshots
      ADD CONSTRAINT job_ranking_snapshots_culture_priority_score_chk
      CHECK (culture_priority_score IS NULL OR culture_priority_score BETWEEN 0 AND 100);
  END IF;
END;
$$;

-- Same stable source posting + changed content is a new immutable job version.
-- Null identities retain content-only deduplication for legacy/manual sources.
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_versions_posting_content
  ON job_versions (workspace_id, canonical_job_id, source_posting_identity_hash, content_hash)
  WHERE source_posting_identity_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_versions_unidentified_content
  ON job_versions (workspace_id, canonical_job_id, content_hash)
  WHERE source_posting_identity_hash IS NULL;
DROP INDEX IF EXISTS uq_job_versions_workspace_canonical_posting_identity;

CREATE TABLE IF NOT EXISTS fx_rate_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency TEXT NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  quote_currency TEXT NOT NULL CHECK (quote_currency ~ '^[A-Z]{3}$'),
  rate NUMERIC(24, 12) NOT NULL CHECK (rate > 0),
  rate_date DATE NOT NULL,
  source_name TEXT NOT NULL CHECK (BTRIM(source_name) <> ''),
  source_url TEXT NOT NULL CHECK (source_url ~ '^https://'),
  source_content_hash TEXT NOT NULL CHECK (source_content_hash ~ '^[a-f0-9]{64}$'),
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (base_currency, quote_currency, rate_date, source_name, source_content_hash)
);
CREATE INDEX IF NOT EXISTS idx_fx_rate_observations_latest
  ON fx_rate_observations (base_currency, quote_currency, rate_date DESC, retrieved_at DESC);

CREATE OR REPLACE FUNCTION prevent_fx_rate_observation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'fx_rate_observations is append-only; insert a new rate observation';
END;
$$;
DROP TRIGGER IF EXISTS trg_fx_rate_observations_immutable ON fx_rate_observations;
CREATE TRIGGER trg_fx_rate_observations_immutable
BEFORE UPDATE OR DELETE ON fx_rate_observations
FOR EACH ROW EXECUTE FUNCTION prevent_fx_rate_observation_mutation();

CREATE UNIQUE INDEX IF NOT EXISTS uq_source_runs_workspace_id_id
  ON source_runs (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_raw_job_observations_workspace_id_id
  ON raw_job_observations (workspace_id, id);

CREATE TABLE IF NOT EXISTS source_plan_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_run_id UUID NOT NULL,
  source_plugin_id UUID NOT NULL REFERENCES source_plugins(id) ON DELETE RESTRICT,
  plan_key TEXT NOT NULL,
  plan_version TEXT NOT NULL,
  lane_key TEXT,
  coverage_note TEXT,
  status TEXT NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING', 'COMPLETED', 'DEGRADED', 'FAILED')),
  pages_processed INTEGER NOT NULL DEFAULT 0 CHECK (pages_processed >= 0),
  items_seen INTEGER NOT NULL DEFAULT 0 CHECK (items_seen >= 0),
  items_staged INTEGER NOT NULL DEFAULT 0 CHECK (items_staged >= 0),
  items_filtered INTEGER NOT NULL DEFAULT 0 CHECK (items_filtered >= 0),
  error_summary JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (source_run_id, source_plugin_id, plan_key, plan_version),
  FOREIGN KEY (workspace_id, source_run_id)
    REFERENCES source_runs(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_plan_runs_workspace_id
  ON source_plan_runs (workspace_id, id);
CREATE INDEX IF NOT EXISTS idx_source_plan_runs_workspace_history
  ON source_plan_runs (workspace_id, started_at DESC, lane_key, status);

CREATE TABLE IF NOT EXISTS source_candidate_dispositions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_run_id UUID NOT NULL,
  source_plan_run_id UUID,
  source_plugin_key TEXT NOT NULL,
  plan_key TEXT NOT NULL,
  lane_key TEXT,
  source_external_id TEXT,
  source_url TEXT,
  raw_payload_hash TEXT NOT NULL CHECK (raw_payload_hash ~ '^[a-f0-9]{64}$'),
  raw_payload JSONB NOT NULL,
  disposition TEXT NOT NULL
    CHECK (disposition IN ('STAGED', 'FILTERED', 'DUPLICATE', 'QUARANTINED', 'ERROR')),
  reason_code TEXT,
  reason_detail TEXT,
  canonical_job_id UUID,
  job_observation_id UUID,
  normalized_evidence JSONB,
  evidence_schema_version TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id, source_run_id)
    REFERENCES source_runs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_plan_run_id)
    REFERENCES source_plan_runs(workspace_id, id),
  FOREIGN KEY (workspace_id, job_observation_id)
    REFERENCES raw_job_observations(workspace_id, id)
);
ALTER TABLE source_candidate_dispositions
  ADD COLUMN IF NOT EXISTS normalized_evidence JSONB,
  ADD COLUMN IF NOT EXISTS evidence_schema_version TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'source_candidate_dispositions'
      AND constraint_name = 'source_candidate_dispositions_normalized_evidence_chk'
  ) THEN
    ALTER TABLE source_candidate_dispositions
      ADD CONSTRAINT source_candidate_dispositions_normalized_evidence_chk
      CHECK (
        (normalized_evidence IS NULL AND evidence_schema_version IS NULL)
        OR (
          jsonb_typeof(normalized_evidence) = 'object'
          AND evidence_schema_version = 'job_source_evidence_v1'
          AND normalized_evidence->>'schema_version' = evidence_schema_version
        )
      );
  END IF;
END;
$$;
CREATE INDEX IF NOT EXISTS idx_source_candidate_dispositions_run_plan
  ON source_candidate_dispositions (workspace_id, source_run_id, source_plugin_key, plan_key, fetched_at);
CREATE INDEX IF NOT EXISTS idx_source_candidate_dispositions_identity
  ON source_candidate_dispositions (workspace_id, source_plugin_key, source_external_id, raw_payload_hash);
CREATE INDEX IF NOT EXISTS idx_source_candidate_dispositions_observation_availability
  ON source_candidate_dispositions (workspace_id, job_observation_id, fetched_at DESC, id DESC)
  WHERE normalized_evidence IS NOT NULL;

COMMENT ON TABLE fx_rate_observations IS
  'Append-only currency conversion observations with attributable source, rate date and content hash.';
COMMENT ON TABLE source_plan_runs IS
  'Per-source/per-lane execution results; distinguishes completed-empty, failed and not-yet-run plans.';
COMMENT ON TABLE source_candidate_dispositions IS
  'Auditable per-candidate source dispositions including filtered, duplicate and quarantined records.';

CREATE OR REPLACE VIEW v_application_readiness_current AS
SELECT
  c.workspace_id,
  c.id AS canonical_job_id,
  c.latest_job_version_id AS job_version_id,
  jv.active_requirement_set_id AS requirement_set_id,
  active_profile.id AS active_profile_version_id,
  c.latest_match_run_id AS match_run_id,
  decision.id AS deterministic_decision_id,
  decision.readiness_json AS application_readiness,
  CASE
    WHEN c.gate_decision = 'HARD_REJECT'
      OR COALESCE(c.processing_state, c.processing_status) = 'HARD_REJECTED' THEN 'BLOCKED'
    WHEN c.latest_job_version_id IS NULL OR jv.id IS NULL THEN 'PROCESSING'
    WHEN active_profile.id IS NULL OR jv.active_requirement_set_id IS NULL
      OR match_run.id IS NULL OR match_run.status <> 'COMPLETED'
      OR match_run.job_version_id IS DISTINCT FROM jv.id
      OR match_run.profile_version_id IS DISTINCT FROM active_profile.id
      OR match_run.requirement_set_id IS DISTINCT FROM jv.active_requirement_set_id
      OR match_run.job_content_hash IS DISTINCT FROM jv.content_hash
      OR match_run.context_fingerprint IS NULL THEN 'PROCESSING'
    WHEN decision.id IS NULL OR decision.readiness_json IS NULL THEN 'NEEDS_VERIFICATION'
    WHEN decision.evidence_revision_hash IS NULL OR jv.evidence_revision_hash IS NULL THEN 'NEEDS_VERIFICATION'
    WHEN decision.evidence_revision_hash IS DISTINCT FROM jv.evidence_revision_hash
      OR decision.readiness_fingerprint IS NULL
      OR decision.readiness_json->>'readiness_fingerprint' IS DISTINCT FROM decision.readiness_fingerprint
      OR decision.readiness_json->>'evidence_revision_hash' IS DISTINCT FROM decision.evidence_revision_hash
      OR decision.job_version_id IS DISTINCT FROM jv.id
      OR decision.match_run_id IS DISTINCT FROM match_run.id
      OR decision.readiness_json->>'canonical_job_id' IS DISTINCT FROM c.id::text
      OR decision.readiness_json->>'job_version_id' IS DISTINCT FROM jv.id::text
      OR decision.readiness_json->>'match_run_id' IS DISTINCT FROM match_run.id::text
      OR decision.readiness_json->>'profile_version_id' IS DISTINCT FROM active_profile.id::text
      OR decision.readiness_json->>'requirement_set_id' IS DISTINCT FROM jv.active_requirement_set_id::text
      OR decision.readiness_json->>'preference_context_id' IS DISTINCT FROM decision.preference_context_id::text
      OR decision.readiness_json->>'policy_snapshot_id' IS DISTINCT FROM decision.policy_snapshot_id::text
      OR policy_snapshot.id IS NULL
      OR policy_snapshot.decision_policy_config_revision_id IS DISTINCT FROM active_decision_policy.config_revision_id
      OR policy_snapshot.evidence_strength_policy_config_revision_id IS DISTINCT FROM active_evidence_policy.config_revision_id
      OR EXISTS (
        SELECT 1
        FROM workspace_user_preference_modes preference_mode
        WHERE preference_mode.workspace_id = c.workspace_id
          AND preference_mode.user_id = decision.preference_user_id
          AND preference_mode.updated_at > NULLIF(decision.readiness_json->>'evaluated_at', '')::timestamptz
      )
      OR EXISTS (
        SELECT 1
        FROM workspace_user_preference_active_versions active_preference
        WHERE active_preference.workspace_id = c.workspace_id
          AND active_preference.user_id = decision.preference_user_id
          AND active_preference.preference_domain IN ('lane_intent', 'stage3')
          AND NOT EXISTS (
            SELECT 1
            FROM workspace_user_preference_context_revisions pinned_preference
            WHERE pinned_preference.workspace_id = active_preference.workspace_id
              AND pinned_preference.user_id = active_preference.user_id
              AND pinned_preference.context_id = decision.preference_context_id
              AND pinned_preference.preference_domain = active_preference.preference_domain
              AND pinned_preference.revision_id = active_preference.revision_id
          )
      )
      OR EXISTS (
        SELECT 1
        FROM workspace_user_preference_context_revisions pinned_preference
        WHERE pinned_preference.workspace_id = c.workspace_id
          AND pinned_preference.user_id = decision.preference_user_id
          AND pinned_preference.context_id = decision.preference_context_id
          AND pinned_preference.preference_domain IN ('lane_intent', 'stage3')
          AND NOT EXISTS (
            SELECT 1
            FROM workspace_user_preference_active_versions active_preference
            WHERE active_preference.workspace_id = pinned_preference.workspace_id
              AND active_preference.user_id = pinned_preference.user_id
              AND active_preference.preference_domain = pinned_preference.preference_domain
              AND active_preference.revision_id = pinned_preference.revision_id
          )
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(decision.readiness_json->'checks', '[]'::jsonb)) AS check_item(value)
        WHERE check_item.value->>'key' = 'AVAILABILITY'
          AND check_item.value->>'policy_reference' IS DISTINCT FROM availability_context.verification_reference
      ) THEN 'PROCESSING'
    WHEN decision.readiness_json->>'status' = 'READY'
      AND NULLIF(decision.readiness_json->>'expires_at', '') IS NULL THEN 'NEEDS_VERIFICATION'
    WHEN NULLIF(decision.readiness_json->>'expires_at', '')::timestamptz <= NOW() THEN 'NEEDS_VERIFICATION'
    ELSE decision.readiness_json->>'status'
  END AS readiness_status,
  CASE
    WHEN decision.readiness_json IS NULL THEN ARRAY['READINESS_NOT_COMPUTED']::text[]
    WHEN decision.evidence_revision_hash IS NULL OR jv.evidence_revision_hash IS NULL THEN ARRAY['READINESS_EVIDENCE_MISSING']::text[]
    WHEN decision.evidence_revision_hash IS DISTINCT FROM jv.evidence_revision_hash THEN ARRAY['READINESS_EVIDENCE_STALE']::text[]
    WHEN decision.readiness_fingerprint IS NULL
      OR decision.readiness_json->>'readiness_fingerprint' IS DISTINCT FROM decision.readiness_fingerprint THEN ARRAY['READINESS_FINGERPRINT_STALE']::text[]
    WHEN decision.readiness_json->>'status' = 'READY'
      AND NULLIF(decision.readiness_json->>'expires_at', '') IS NULL THEN ARRAY['READINESS_EXPIRY_MISSING']::text[]
    WHEN (
        decision.job_version_id IS DISTINCT FROM jv.id
        OR decision.match_run_id IS DISTINCT FROM match_run.id
        OR decision.readiness_json->>'canonical_job_id' IS DISTINCT FROM c.id::text
        OR decision.readiness_json->>'job_version_id' IS DISTINCT FROM jv.id::text
        OR decision.readiness_json->>'match_run_id' IS DISTINCT FROM match_run.id::text
        OR decision.readiness_json->>'profile_version_id' IS DISTINCT FROM active_profile.id::text
        OR decision.readiness_json->>'requirement_set_id' IS DISTINCT FROM jv.active_requirement_set_id::text
        OR decision.readiness_json->>'preference_context_id' IS DISTINCT FROM decision.preference_context_id::text
        OR decision.readiness_json->>'policy_snapshot_id' IS DISTINCT FROM decision.policy_snapshot_id::text
        OR policy_snapshot.id IS NULL
        OR policy_snapshot.decision_policy_config_revision_id IS DISTINCT FROM active_decision_policy.config_revision_id
        OR policy_snapshot.evidence_strength_policy_config_revision_id IS DISTINCT FROM active_evidence_policy.config_revision_id
        OR EXISTS (
          SELECT 1 FROM workspace_user_preference_modes preference_mode
          WHERE preference_mode.workspace_id = c.workspace_id
            AND preference_mode.user_id = decision.preference_user_id
            AND preference_mode.updated_at > NULLIF(decision.readiness_json->>'evaluated_at', '')::timestamptz
        )
        OR EXISTS (
          SELECT 1 FROM workspace_user_preference_active_versions active_preference
          WHERE active_preference.workspace_id = c.workspace_id
            AND active_preference.user_id = decision.preference_user_id
            AND active_preference.preference_domain IN ('lane_intent', 'stage3')
            AND NOT EXISTS (
              SELECT 1 FROM workspace_user_preference_context_revisions pinned_preference
              WHERE pinned_preference.workspace_id = active_preference.workspace_id
                AND pinned_preference.user_id = active_preference.user_id
                AND pinned_preference.context_id = decision.preference_context_id
                AND pinned_preference.preference_domain = active_preference.preference_domain
                AND pinned_preference.revision_id = active_preference.revision_id
            )
        )
        OR EXISTS (
          SELECT 1 FROM workspace_user_preference_context_revisions pinned_preference
          WHERE pinned_preference.workspace_id = c.workspace_id
            AND pinned_preference.user_id = decision.preference_user_id
            AND pinned_preference.context_id = decision.preference_context_id
            AND pinned_preference.preference_domain IN ('lane_intent', 'stage3')
            AND NOT EXISTS (
              SELECT 1 FROM workspace_user_preference_active_versions active_preference
              WHERE active_preference.workspace_id = pinned_preference.workspace_id
                AND active_preference.user_id = pinned_preference.user_id
                AND active_preference.preference_domain = pinned_preference.preference_domain
                AND active_preference.revision_id = pinned_preference.revision_id
            )
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(decision.readiness_json->'checks', '[]'::jsonb)) AS check_item(value)
          WHERE check_item.value->>'key' = 'AVAILABILITY'
            AND check_item.value->>'policy_reference' IS DISTINCT FROM availability_context.verification_reference
        )
      ) THEN ARRAY['READINESS_CONTEXT_STALE']::text[]
    WHEN NULLIF(decision.readiness_json->>'expires_at', '')::timestamptz <= NOW() THEN ARRAY['READINESS_EVIDENCE_EXPIRED']::text[]
    ELSE ARRAY(SELECT jsonb_array_elements_text(COALESCE(decision.readiness_json->'reason_codes', '[]'::jsonb)))
  END AS readiness_reason_codes,
  decision.readiness_fingerprint,
  NULLIF(decision.readiness_json->>'expires_at', '')::timestamptz AS readiness_expires_at,
  COALESCE(decision.evidence_revision_hash, jv.evidence_revision_hash) AS evidence_revision_hash,
  CASE
    WHEN current_source_evidence.normalized_evidence IS NOT NULL
      THEN current_source_evidence.normalized_evidence->'availability'->>'status'
    ELSE jv.availability_status
  END AS availability_status,
  CASE
    WHEN current_source_evidence.normalized_evidence IS NOT NULL
      THEN NULLIF(current_source_evidence.normalized_evidence->'availability'->>'verified_at', '')::timestamptz
    ELSE jv.availability_verified_at
  END AS availability_verified_at,
  CASE
    WHEN current_source_evidence.normalized_evidence IS NOT NULL
      THEN NULLIF(current_source_evidence.normalized_evidence->'availability'->>'expires_at', '')::timestamptz
    ELSE jv.availability_recheck_at
  END AS availability_recheck_at,
  jv.source_published_at,
  jv.source_expires_at,
  current_source_evidence.normalized_evidence AS job_source_evidence,
  '8.0.0'::text AS read_model_version
FROM canonical_jobs c
LEFT JOIN job_versions jv
  ON jv.workspace_id = c.workspace_id
 AND jv.canonical_job_id = c.id
 AND jv.id = c.latest_job_version_id
LEFT JOIN LATERAL (
  SELECT profile.id
  FROM profile_versions profile
  WHERE profile.workspace_id = c.workspace_id
    AND profile.status = 'ACTIVE'
  ORDER BY profile.created_at DESC, profile.id DESC
  LIMIT 1
) active_profile ON TRUE
LEFT JOIN match_runs match_run
  ON match_run.workspace_id = c.workspace_id
 AND match_run.id = c.latest_match_run_id
LEFT JOIN deterministic_decisions decision
  ON decision.workspace_id = c.workspace_id
 AND decision.id = c.latest_deterministic_decision_id
 AND decision.canonical_job_id = c.id
LEFT JOIN workspace_policy_snapshots policy_snapshot
  ON policy_snapshot.workspace_id = c.workspace_id
 AND policy_snapshot.id = decision.policy_snapshot_id
LEFT JOIN LATERAL (
  SELECT active.config_revision_id
  FROM config_active_revisions active
  JOIN config_definitions definition
    ON definition.id = active.config_definition_id
  WHERE definition.workspace_id = c.workspace_id
    AND definition.config_key = 'decision_policy'
  LIMIT 1
) active_decision_policy ON TRUE
LEFT JOIN LATERAL (
  SELECT active.config_revision_id
  FROM config_active_revisions active
  JOIN config_definitions definition
    ON definition.id = active.config_definition_id
  WHERE definition.workspace_id = c.workspace_id
    AND definition.config_key = 'evidence_strength'
  LIMIT 1
) active_evidence_policy ON TRUE
LEFT JOIN LATERAL (
  SELECT evidence_event.normalized_evidence
  FROM (
    SELECT observation.normalized_evidence,
           observation.retrieved_at AS observed_at,
           observation.id AS event_id
    FROM raw_job_observations observation
    WHERE observation.workspace_id = c.workspace_id
      AND observation.job_version_id = jv.id
      AND observation.normalized_evidence IS NOT NULL
    UNION ALL
    SELECT disposition.normalized_evidence,
           disposition.fetched_at AS observed_at,
           disposition.id AS event_id
    FROM source_candidate_dispositions disposition
    JOIN raw_job_observations observation
      ON observation.workspace_id = disposition.workspace_id
     AND observation.id = disposition.job_observation_id
     AND observation.job_version_id = jv.id
    WHERE disposition.workspace_id = c.workspace_id
      AND disposition.normalized_evidence IS NOT NULL
  ) evidence_event
  ORDER BY evidence_event.observed_at DESC, evidence_event.event_id DESC
  LIMIT 1
) current_source_evidence ON TRUE
LEFT JOIN LATERAL (
  SELECT
    'availability_verification_v1:'
      || CASE
        WHEN current_source_evidence.normalized_evidence IS NOT NULL
          THEN COALESCE(NULLIF(current_source_evidence.normalized_evidence->'availability'->>'verified_at', ''), 'unknown')
        ELSE COALESCE(to_char(jv.availability_verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'unknown')
      END
      || ':'
      || CASE
        WHEN current_source_evidence.normalized_evidence IS NOT NULL
          THEN COALESCE(NULLIF(current_source_evidence.normalized_evidence->'availability'->>'expires_at', ''), 'unknown')
        ELSE COALESCE(to_char(jv.availability_recheck_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'unknown')
      END AS verification_reference
) availability_context ON TRUE;

CREATE OR REPLACE VIEW v_canonical_shortlist_readiness_scoped AS
SELECT
  shortlist.*,
  readiness.application_readiness,
  readiness.readiness_status,
  readiness.readiness_reason_codes,
  readiness.readiness_fingerprint,
  readiness.readiness_expires_at,
  readiness.evidence_revision_hash,
  readiness.availability_status,
  readiness.availability_verified_at,
  readiness.availability_recheck_at,
  readiness.source_published_at,
  readiness.source_expires_at,
  readiness.job_source_evidence,
  readiness.read_model_version
FROM v_canonical_shortlist_scoped shortlist
LEFT JOIN v_application_readiness_current readiness
  ON readiness.workspace_id = shortlist.workspace_id
 AND readiness.canonical_job_id = shortlist.canonical_job_id
 AND readiness.job_version_id::text = shortlist.job_version_id::text;

COMMENT ON VIEW v_application_readiness_current IS
  'Current per-job READY/BLOCKED/NEEDS_VERIFICATION/PROCESSING state with profile, requirement, match, evidence, and TTL lineage.';
COMMENT ON VIEW v_canonical_shortlist_readiness_scoped IS
  'Workspace-scoped shortlist extended with the canonical versioned application-readiness and source-evidence contract.';

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
   AND decision.recommendation_outcome = shortlist.recommendation_outcome
  LEFT JOIN LATERAL (
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
  AND current_decisions.recommendation_outcome IN ('PRIORITY', 'REVIEW')
  AND EXISTS (
    SELECT 1
    FROM v_application_readiness_current readiness
    WHERE readiness.workspace_id = current_decisions.workspace_id
      AND readiness.canonical_job_id = current_decisions.canonical_job_id
      AND readiness.job_version_id::text = current_decisions.job_version_id::text
      AND readiness.readiness_status = 'READY'
      AND readiness.readiness_fingerprint IS NOT NULL
  );

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
    ) AS ranking_position,
    active_profile.id AS profile_version_id,
    match_run.id AS match_run_id,
    decision.id AS deterministic_decision_id,
    ai_evaluation.id AS ai_evaluation_id,
    ranking.requirement_fit_score,
    ranking.requirement_coverage_score,
    ranking.evidence_completeness_score,
    ranking.lane_confidence_score,
    ranking.autonomy_score,
    ranking.politics_risk_score,
    ranking.sensory_workload_risk_score,
    ranking.strategic_value_score,
    ranking.focus_protection_score,
    ranking.building_ratio_score,
    ranking.interaction_burden_score
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
      AND evaluation.profile_version_id = active_profile.id
      AND evaluation.match_run_id = match_run.id
      AND evaluation.deterministic_decision_id = decision.id
      AND evaluation.job_content_hash = job_version.content_hash
      AND evaluation.context_fingerprint = decision.context_fingerprint
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
    AND ai_evaluation.context_fingerprint IS NOT NULL
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
    AND EXISTS (
      SELECT 1
      FROM v_application_readiness_current readiness
      WHERE readiness.workspace_id = job.workspace_id
        AND readiness.canonical_job_id = job.id
        AND readiness.job_version_id = job_version.id
        AND readiness.readiness_status = 'READY'
        AND readiness.readiness_fingerprint = decision.readiness_fingerprint
    )
)
SELECT current_rankings.*
FROM current_rankings
WHERE current_rankings.ranking_position <= 10;

COMMENT ON VIEW v_apply_now_jobs_scoped IS
  'Apply Now rows require a current READY readiness assessment in addition to existing fit and artifact lineage.';
COMMENT ON VIEW v_top_ten_ready_jobs_scoped IS
  'Top Ten rows require a current READY readiness assessment matching the latest deterministic decision.';
