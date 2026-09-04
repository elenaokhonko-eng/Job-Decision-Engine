-- Migration 020: Workspace, configuration registry, and workspace scoping
--
-- Goals (IDE Closeout Pack P2):
-- 1) Introduce workspaces/users/memberships.
-- 2) Scope candidate-owned rows (jobs, observations, profiles, configs, artifacts) to a workspace.
-- 3) Add configuration definition/revision/activation/audit tables.
--
-- Notes:
-- - Additive + reversible (no drops of user data). Index drops are required to remove
--   global uniqueness that would violate cross-workspace isolation.
-- - Existing migrations 001–019 must not be edited.

BEGIN;

-- ============================================================================
-- 1) Core workspace identity + membership
-- ============================================================================

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_workspace_key ON workspaces(workspace_key);

CREATE TABLE IF NOT EXISTS workspace_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_users_user_key ON workspace_users(user_key);

CREATE TABLE IF NOT EXISTS workspace_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES workspace_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'MEMBER', 'READER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_memberships_workspace ON workspace_memberships(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_memberships_user ON workspace_memberships(user_id);

-- Default bootstrap workspace/user for single-user/dev flows.
INSERT INTO workspaces (workspace_key, display_name)
VALUES ('default', 'Default Workspace')
ON CONFLICT (workspace_key) DO NOTHING;

INSERT INTO workspace_users (user_key, display_name, email)
VALUES ('local_user', 'Local User', NULL)
ON CONFLICT (user_key) DO NOTHING;

INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
SELECT w.id, u.id, 'OWNER', 'ACTIVE'
FROM workspaces w
JOIN workspace_users u ON u.user_key = 'local_user'
WHERE w.workspace_key = 'default'
ON CONFLICT (workspace_id, user_id) DO NOTHING;

-- Helper functions used as defaults in newly scoped tables.
CREATE OR REPLACE FUNCTION jdec_default_workspace_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT id FROM workspaces WHERE workspace_key = 'default' LIMIT 1
$$;

CREATE OR REPLACE FUNCTION jdec_default_user_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT id FROM workspace_users WHERE user_key = 'local_user' LIMIT 1
$$;

-- ============================================================================
-- 2) Candidate-owned table workspace scoping
-- ============================================================================

-- Stage 0 discovery
ALTER TABLE source_runs ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE source_runs SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE source_runs ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE source_runs ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_source_runs_workspace_id ON source_runs(workspace_id);

ALTER TABLE raw_job_observations ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE raw_job_observations SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE raw_job_observations ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE raw_job_observations ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_raw_job_observations_workspace_id ON raw_job_observations(workspace_id);

-- Replace global payload-hash uniqueness with per-workspace uniqueness.
DROP INDEX IF EXISTS idx_raw_job_observations_payload_hash;
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_job_observations_payload_hash
  ON raw_job_observations (workspace_id, raw_payload_hash);

ALTER TABLE canonical_jobs ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE canonical_jobs SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE canonical_jobs ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE canonical_jobs ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_canonical_jobs_workspace_id ON canonical_jobs(workspace_id);

ALTER TABLE job_versions ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE job_versions jv
SET workspace_id = c.workspace_id
FROM canonical_jobs c
WHERE jv.canonical_job_id = c.id
  AND jv.workspace_id IS NULL;
UPDATE job_versions SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE job_versions ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE job_versions ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_versions_workspace_id ON job_versions(workspace_id);

ALTER TABLE evaluation_queue ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE evaluation_queue eq
SET workspace_id = c.workspace_id
FROM canonical_jobs c
WHERE eq.canonical_job_id = c.id
  AND eq.workspace_id IS NULL;
UPDATE evaluation_queue SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE evaluation_queue ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE evaluation_queue ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_evaluation_queue_workspace_id ON evaluation_queue(workspace_id);

ALTER TABLE ai_evaluations ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE ai_evaluations ae
SET workspace_id = c.workspace_id
FROM canonical_jobs c
WHERE ae.canonical_job_id = c.id
  AND ae.workspace_id IS NULL;
UPDATE ai_evaluations SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE ai_evaluations ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE ai_evaluations ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_evaluations_workspace_id ON ai_evaluations(workspace_id);

-- Gmail alerts (non-destructive)
ALTER TABLE raw_email_alerts ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE raw_email_alerts SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE raw_email_alerts ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE raw_email_alerts ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_raw_email_alerts_workspace_id ON raw_email_alerts(workspace_id);

-- Replace global Gmail UID uniqueness with per-workspace uniqueness.
DROP INDEX IF EXISTS idx_raw_email_alerts_gmail_uid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_email_alerts_gmail_uid
  ON raw_email_alerts (workspace_id, gmail_message_id);

-- Gate decisions
ALTER TABLE gate_decisions ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE gate_decisions gd
SET workspace_id = c.workspace_id
FROM canonical_jobs c
WHERE gd.canonical_job_id = c.id
  AND gd.workspace_id IS NULL;
UPDATE gate_decisions SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE gate_decisions ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE gate_decisions ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gate_decisions_workspace_id ON gate_decisions(workspace_id);

-- Quarantine / attempts
ALTER TABLE quarantined_queue_records ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE quarantined_queue_records qq
SET workspace_id = c.workspace_id
FROM canonical_jobs c
WHERE qq.canonical_job_id = c.id
  AND qq.workspace_id IS NULL;
UPDATE quarantined_queue_records SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE quarantined_queue_records ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE quarantined_queue_records ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quarantined_queue_records_workspace_id ON quarantined_queue_records(workspace_id);

ALTER TABLE evaluation_attempts ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE evaluation_attempts ea
SET workspace_id = c.workspace_id
FROM canonical_jobs c
WHERE ea.canonical_job_id = c.id
  AND ea.workspace_id IS NULL;
UPDATE evaluation_attempts SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE evaluation_attempts ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE evaluation_attempts ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_evaluation_attempts_workspace_id ON evaluation_attempts(workspace_id);

-- Requirements + pipeline state
ALTER TABLE job_requirements ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE job_requirements jr
SET workspace_id = jv.workspace_id
FROM job_versions jv
WHERE jr.job_version_id = jv.id
  AND jr.workspace_id IS NULL;
UPDATE job_requirements SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE job_requirements ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE job_requirements ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_requirements_workspace_id ON job_requirements(workspace_id);

ALTER TABLE requirement_extraction_runs ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE requirement_extraction_runs rer
SET workspace_id = jv.workspace_id
FROM job_versions jv
WHERE rer.job_version_id = jv.id
  AND rer.workspace_id IS NULL;
UPDATE requirement_extraction_runs SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE requirement_extraction_runs ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE requirement_extraction_runs ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_requirement_extraction_runs_workspace_id ON requirement_extraction_runs(workspace_id);

ALTER TABLE job_version_pipeline_state ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE job_version_pipeline_state jvps
SET workspace_id = jv.workspace_id
FROM job_versions jv
WHERE jvps.job_version_id = jv.id
  AND jvps.workspace_id IS NULL;
UPDATE job_version_pipeline_state SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE job_version_pipeline_state ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE job_version_pipeline_state ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_version_pipeline_state_workspace_id ON job_version_pipeline_state(workspace_id);

ALTER TABLE pipeline_stage_events ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE pipeline_stage_events pse
SET workspace_id = jv.workspace_id
FROM job_versions jv
WHERE pse.job_version_id = jv.id
  AND pse.workspace_id IS NULL;
UPDATE pipeline_stage_events SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE pipeline_stage_events ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE pipeline_stage_events ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pipeline_stage_events_workspace_id ON pipeline_stage_events(workspace_id);

-- Deterministic matching
ALTER TABLE match_runs ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE match_runs mr
SET workspace_id = c.workspace_id
FROM canonical_jobs c
WHERE mr.canonical_job_id = c.id
  AND mr.workspace_id IS NULL;
UPDATE match_runs SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE match_runs ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE match_runs ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_match_runs_workspace_id ON match_runs(workspace_id);

ALTER TABLE requirement_evidence_matches ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE requirement_evidence_matches rem
SET workspace_id = mr.workspace_id
FROM match_runs mr
WHERE rem.match_run_id = mr.id
  AND rem.workspace_id IS NULL;
UPDATE requirement_evidence_matches SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE requirement_evidence_matches ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE requirement_evidence_matches ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_requirement_evidence_matches_workspace_id ON requirement_evidence_matches(workspace_id);

-- Embeddings
ALTER TABLE embedding_spaces ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE embedding_spaces SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE embedding_spaces ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE embedding_spaces ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_embedding_spaces_workspace_id ON embedding_spaces(workspace_id);

ALTER TABLE embedding_inputs ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE embedding_inputs SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE embedding_inputs ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE embedding_inputs ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_embedding_inputs_workspace_id ON embedding_inputs(workspace_id);

ALTER TABLE embedding_batches ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE embedding_batches SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE embedding_batches ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE embedding_batches ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_embedding_batches_workspace_id ON embedding_batches(workspace_id);

	ALTER TABLE embedding_batch_items ADD COLUMN IF NOT EXISTS workspace_id UUID;
	UPDATE embedding_batch_items ebi
	SET workspace_id = eb.workspace_id
	FROM embedding_batches eb
	WHERE ebi.embedding_batch_id = eb.id
	  AND ebi.workspace_id IS NULL;
	UPDATE embedding_batch_items SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
	ALTER TABLE embedding_batch_items ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
	ALTER TABLE embedding_batch_items ALTER COLUMN workspace_id SET NOT NULL;
	CREATE INDEX IF NOT EXISTS idx_embedding_batch_items_workspace_id ON embedding_batch_items(workspace_id);

	ALTER TABLE semantic_embeddings ADD COLUMN IF NOT EXISTS workspace_id UUID;
	UPDATE semantic_embeddings se
	SET workspace_id = eb.workspace_id
	FROM embedding_batches eb
	WHERE se.embedding_batch_id = eb.id
	  AND se.workspace_id IS NULL;
	UPDATE semantic_embeddings SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
	ALTER TABLE semantic_embeddings ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
	ALTER TABLE semantic_embeddings ALTER COLUMN workspace_id SET NOT NULL;
	CREATE INDEX IF NOT EXISTS idx_semantic_embeddings_workspace_id ON semantic_embeddings(workspace_id);

-- Replace global embedding uniqueness with per-workspace uniqueness.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'embedding_spaces'
      AND constraint_type = 'UNIQUE'
      AND constraint_name = 'embedding_spaces_space_key_key'
  ) THEN
    ALTER TABLE embedding_spaces DROP CONSTRAINT embedding_spaces_space_key_key;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_embedding_spaces_workspace_space_key
  ON embedding_spaces (workspace_id, space_key);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'embedding_inputs'
      AND constraint_type = 'UNIQUE'
      AND constraint_name = 'embedding_inputs_input_key_key'
  ) THEN
    ALTER TABLE embedding_inputs DROP CONSTRAINT embedding_inputs_input_key_key;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'embedding_inputs'
      AND constraint_type = 'UNIQUE'
      AND constraint_name = 'embedding_inputs_source_type_source_id_key'
  ) THEN
    ALTER TABLE embedding_inputs DROP CONSTRAINT embedding_inputs_source_type_source_id_key;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_embedding_inputs_workspace_input_key
  ON embedding_inputs (workspace_id, input_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_embedding_inputs_workspace_source
  ON embedding_inputs (workspace_id, source_type, source_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'embedding_batches'
      AND constraint_type = 'UNIQUE'
      AND constraint_name = 'embedding_batches_batch_key_key'
  ) THEN
    ALTER TABLE embedding_batches DROP CONSTRAINT embedding_batches_batch_key_key;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_embedding_batches_workspace_batch_key
  ON embedding_batches (workspace_id, batch_key);

-- Documents
ALTER TABLE document_runs ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE document_runs SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE document_runs ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE document_runs ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_document_runs_workspace_id ON document_runs(workspace_id);

ALTER TABLE document_claims ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE document_claims dc
SET workspace_id = dr.workspace_id
FROM document_runs dr
WHERE dc.document_run_id = dr.id
  AND dc.workspace_id IS NULL;
UPDATE document_claims SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE document_claims ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE document_claims ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_document_claims_workspace_id ON document_claims(workspace_id);

-- Profiles + evidence ledger
ALTER TABLE candidate_profiles ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE candidate_profiles SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE candidate_profiles ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE candidate_profiles ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_candidate_profiles_workspace_id ON candidate_profiles(workspace_id);

-- Replace global profile_key uniqueness with per-workspace uniqueness.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'candidate_profiles'
      AND constraint_type = 'UNIQUE'
      AND constraint_name = 'candidate_profiles_profile_key_key'
  ) THEN
    ALTER TABLE candidate_profiles DROP CONSTRAINT candidate_profiles_profile_key_key;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_profiles_workspace_profile_key
  ON candidate_profiles (workspace_id, profile_key);

ALTER TABLE profile_versions ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE profile_versions pv
SET workspace_id = cp.workspace_id
FROM candidate_profiles cp
WHERE pv.candidate_profile_id = cp.id
  AND pv.workspace_id IS NULL;
UPDATE profile_versions SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE profile_versions ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE profile_versions ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profile_versions_workspace_id ON profile_versions(workspace_id);

ALTER TABLE profile_engagements ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE profile_engagements pe
SET workspace_id = pv.workspace_id
FROM profile_versions pv
WHERE pe.profile_version_id = pv.id
  AND pe.workspace_id IS NULL;
UPDATE profile_engagements SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE profile_engagements ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE profile_engagements ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profile_engagements_workspace_id ON profile_engagements(workspace_id);

ALTER TABLE profile_facts ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE profile_facts pf
SET workspace_id = pv.workspace_id
FROM profile_versions pv
WHERE pf.profile_version_id = pv.id
  AND pf.workspace_id IS NULL;
UPDATE profile_facts SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE profile_facts ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE profile_facts ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profile_facts_workspace_id ON profile_facts(workspace_id);

ALTER TABLE profile_fact_concepts ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE profile_fact_concepts pfc
SET workspace_id = pf.workspace_id
FROM profile_facts pf
WHERE pfc.profile_fact_id = pf.id
  AND pfc.workspace_id IS NULL;
UPDATE profile_fact_concepts SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE profile_fact_concepts ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE profile_fact_concepts ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profile_fact_concepts_workspace_id ON profile_fact_concepts(workspace_id);

ALTER TABLE profile_credentials ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE profile_credentials pc
SET workspace_id = pv.workspace_id
FROM profile_versions pv
WHERE pc.profile_version_id = pv.id
  AND pc.workspace_id IS NULL;
UPDATE profile_credentials SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE profile_credentials ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE profile_credentials ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profile_credentials_workspace_id ON profile_credentials(workspace_id);

ALTER TABLE evidence_sources ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE evidence_sources es
SET workspace_id = cp.workspace_id
FROM candidate_profiles cp
WHERE es.candidate_profile_id = cp.id
  AND es.workspace_id IS NULL;
UPDATE evidence_sources SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE evidence_sources ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE evidence_sources ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_evidence_sources_workspace_id ON evidence_sources(workspace_id);

ALTER TABLE profile_fact_evidence_sources ADD COLUMN IF NOT EXISTS workspace_id UUID;
UPDATE profile_fact_evidence_sources pfes
SET workspace_id = pf.workspace_id
FROM profile_facts pf
WHERE pfes.profile_fact_id = pf.id
  AND pfes.workspace_id IS NULL;
UPDATE profile_fact_evidence_sources SET workspace_id = jdec_default_workspace_id() WHERE workspace_id IS NULL;
ALTER TABLE profile_fact_evidence_sources ALTER COLUMN workspace_id SET DEFAULT jdec_default_workspace_id();
ALTER TABLE profile_fact_evidence_sources ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profile_fact_evidence_sources_workspace_id ON profile_fact_evidence_sources(workspace_id);

-- ============================================================================
-- 3) Configuration registry (definition → revisions → activation/audit)
-- ============================================================================

CREATE TABLE IF NOT EXISTS config_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  config_key TEXT NOT NULL,
  config_type TEXT NOT NULL,
  description TEXT,
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, config_key)
);

CREATE INDEX IF NOT EXISTS idx_config_definitions_workspace ON config_definitions(workspace_id);

CREATE TABLE IF NOT EXISTS config_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_definition_id UUID NOT NULL REFERENCES config_definitions(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  schema_version TEXT NOT NULL DEFAULT '2.2.0',
  content_hash TEXT NOT NULL,
  content JSONB NOT NULL,
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (config_definition_id, revision_number),
  UNIQUE (config_definition_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_config_revisions_definition ON config_revisions(config_definition_id, created_at DESC);

-- Revisions are immutable (approval/activation is recorded separately).
CREATE OR REPLACE FUNCTION config_revisions_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'config_revisions rows are immutable; insert a new revision instead.';
END
$$;

DROP TRIGGER IF EXISTS trg_config_revisions_immutable ON config_revisions;
CREATE TRIGGER trg_config_revisions_immutable
BEFORE UPDATE OR DELETE ON config_revisions
FOR EACH ROW EXECUTE FUNCTION config_revisions_immutable_guard();

CREATE TABLE IF NOT EXISTS config_revision_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_revision_id UUID NOT NULL REFERENCES config_revisions(id) ON DELETE CASCADE,
  approved_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (config_revision_id)
);

CREATE TABLE IF NOT EXISTS config_active_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_definition_id UUID NOT NULL REFERENCES config_definitions(id) ON DELETE CASCADE,
  config_revision_id UUID NOT NULL REFERENCES config_revisions(id) ON DELETE RESTRICT,
  activated_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (config_definition_id)
);

CREATE INDEX IF NOT EXISTS idx_config_active_revisions_definition ON config_active_revisions(config_definition_id);

CREATE TABLE IF NOT EXISTS config_activation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_definition_id UUID NOT NULL REFERENCES config_definitions(id) ON DELETE CASCADE,
  from_revision_id UUID REFERENCES config_revisions(id) ON DELETE SET NULL,
  to_revision_id UUID REFERENCES config_revisions(id) ON DELETE SET NULL,
  activated_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_config_activation_events_definition ON config_activation_events(config_definition_id, activated_at DESC);

-- ============================================================================
-- 4) Workspace foreign keys (valid workspace_id everywhere)
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'source_runs' AND constraint_name = 'fk_source_runs_workspace'
  ) THEN
    ALTER TABLE source_runs
      ADD CONSTRAINT fk_source_runs_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'raw_job_observations' AND constraint_name = 'fk_raw_job_observations_workspace'
  ) THEN
    ALTER TABLE raw_job_observations
      ADD CONSTRAINT fk_raw_job_observations_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'canonical_jobs' AND constraint_name = 'fk_canonical_jobs_workspace'
  ) THEN
    ALTER TABLE canonical_jobs
      ADD CONSTRAINT fk_canonical_jobs_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'job_versions' AND constraint_name = 'fk_job_versions_workspace'
  ) THEN
    ALTER TABLE job_versions
      ADD CONSTRAINT fk_job_versions_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'evaluation_queue' AND constraint_name = 'fk_evaluation_queue_workspace'
  ) THEN
    ALTER TABLE evaluation_queue
      ADD CONSTRAINT fk_evaluation_queue_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'ai_evaluations' AND constraint_name = 'fk_ai_evaluations_workspace'
  ) THEN
    ALTER TABLE ai_evaluations
      ADD CONSTRAINT fk_ai_evaluations_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'raw_email_alerts' AND constraint_name = 'fk_raw_email_alerts_workspace'
  ) THEN
    ALTER TABLE raw_email_alerts
      ADD CONSTRAINT fk_raw_email_alerts_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'gate_decisions' AND constraint_name = 'fk_gate_decisions_workspace'
  ) THEN
    ALTER TABLE gate_decisions
      ADD CONSTRAINT fk_gate_decisions_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'quarantined_queue_records' AND constraint_name = 'fk_quarantined_queue_records_workspace'
  ) THEN
    ALTER TABLE quarantined_queue_records
      ADD CONSTRAINT fk_quarantined_queue_records_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'evaluation_attempts' AND constraint_name = 'fk_evaluation_attempts_workspace'
  ) THEN
    ALTER TABLE evaluation_attempts
      ADD CONSTRAINT fk_evaluation_attempts_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'job_requirements' AND constraint_name = 'fk_job_requirements_workspace'
  ) THEN
    ALTER TABLE job_requirements
      ADD CONSTRAINT fk_job_requirements_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'requirement_extraction_runs' AND constraint_name = 'fk_requirement_extraction_runs_workspace'
  ) THEN
    ALTER TABLE requirement_extraction_runs
      ADD CONSTRAINT fk_requirement_extraction_runs_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'job_version_pipeline_state' AND constraint_name = 'fk_job_version_pipeline_state_workspace'
  ) THEN
    ALTER TABLE job_version_pipeline_state
      ADD CONSTRAINT fk_job_version_pipeline_state_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'pipeline_stage_events' AND constraint_name = 'fk_pipeline_stage_events_workspace'
  ) THEN
    ALTER TABLE pipeline_stage_events
      ADD CONSTRAINT fk_pipeline_stage_events_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'match_runs' AND constraint_name = 'fk_match_runs_workspace'
  ) THEN
    ALTER TABLE match_runs
      ADD CONSTRAINT fk_match_runs_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'requirement_evidence_matches' AND constraint_name = 'fk_requirement_evidence_matches_workspace'
  ) THEN
    ALTER TABLE requirement_evidence_matches
      ADD CONSTRAINT fk_requirement_evidence_matches_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'embedding_spaces' AND constraint_name = 'fk_embedding_spaces_workspace'
  ) THEN
    ALTER TABLE embedding_spaces
      ADD CONSTRAINT fk_embedding_spaces_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'embedding_inputs' AND constraint_name = 'fk_embedding_inputs_workspace'
  ) THEN
    ALTER TABLE embedding_inputs
      ADD CONSTRAINT fk_embedding_inputs_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'embedding_batches' AND constraint_name = 'fk_embedding_batches_workspace'
  ) THEN
    ALTER TABLE embedding_batches
      ADD CONSTRAINT fk_embedding_batches_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'embedding_batch_items' AND constraint_name = 'fk_embedding_batch_items_workspace'
  ) THEN
    ALTER TABLE embedding_batch_items
      ADD CONSTRAINT fk_embedding_batch_items_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'semantic_embeddings' AND constraint_name = 'fk_semantic_embeddings_workspace'
  ) THEN
    ALTER TABLE semantic_embeddings
      ADD CONSTRAINT fk_semantic_embeddings_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'document_runs' AND constraint_name = 'fk_document_runs_workspace'
  ) THEN
    ALTER TABLE document_runs
      ADD CONSTRAINT fk_document_runs_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'document_claims' AND constraint_name = 'fk_document_claims_workspace'
  ) THEN
    ALTER TABLE document_claims
      ADD CONSTRAINT fk_document_claims_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'candidate_profiles' AND constraint_name = 'fk_candidate_profiles_workspace'
  ) THEN
    ALTER TABLE candidate_profiles
      ADD CONSTRAINT fk_candidate_profiles_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'profile_versions' AND constraint_name = 'fk_profile_versions_workspace'
  ) THEN
    ALTER TABLE profile_versions
      ADD CONSTRAINT fk_profile_versions_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'profile_engagements' AND constraint_name = 'fk_profile_engagements_workspace'
  ) THEN
    ALTER TABLE profile_engagements
      ADD CONSTRAINT fk_profile_engagements_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'profile_facts' AND constraint_name = 'fk_profile_facts_workspace'
  ) THEN
    ALTER TABLE profile_facts
      ADD CONSTRAINT fk_profile_facts_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'profile_fact_concepts' AND constraint_name = 'fk_profile_fact_concepts_workspace'
  ) THEN
    ALTER TABLE profile_fact_concepts
      ADD CONSTRAINT fk_profile_fact_concepts_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'profile_credentials' AND constraint_name = 'fk_profile_credentials_workspace'
  ) THEN
    ALTER TABLE profile_credentials
      ADD CONSTRAINT fk_profile_credentials_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'evidence_sources' AND constraint_name = 'fk_evidence_sources_workspace'
  ) THEN
    ALTER TABLE evidence_sources
      ADD CONSTRAINT fk_evidence_sources_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'profile_fact_evidence_sources' AND constraint_name = 'fk_profile_fact_evidence_sources_workspace'
  ) THEN
    ALTER TABLE profile_fact_evidence_sources
      ADD CONSTRAINT fk_profile_fact_evidence_sources_workspace
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;
END $$;

COMMIT;
