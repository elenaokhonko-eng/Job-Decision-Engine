-- Manual document preparation is an explicit, version-pinned user override.
-- It never changes automatic suitability/readiness/recommendation or application status.
-- Migration 081 is reserved by the Gmail posting retrieval lineage work.
--
-- Rollback: stop manual-preparation writers first. The tables are append-only
-- private history; retain this migration and disable the route rather than
-- dropping approved comparisons or document bytes.

CREATE UNIQUE INDEX IF NOT EXISTS uq_candidate_profiles_workspace_id_id
  ON candidate_profiles (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_canonical_jobs_workspace_id_id
  ON canonical_jobs (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_versions_workspace_job_id_id
  ON job_versions (workspace_id, canonical_job_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_versions_workspace_candidate_id
  ON profile_versions (workspace_id, candidate_profile_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_facts_workspace_profile_id
  ON profile_facts (workspace_id, profile_version_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_credentials_workspace_profile_id
  ON profile_credentials (workspace_id, profile_version_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_engagements_workspace_profile_id
  ON profile_engagements (workspace_id, profile_version_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_requirement_sets_workspace_job_version_id
  ON requirement_sets (workspace_id, canonical_job_id, job_version_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_raw_observations_workspace_id_version
  ON raw_job_observations (workspace_id, id, job_version_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'job_versions'::regclass AND conname = 'job_versions_workspace_job_fk') THEN
    ALTER TABLE job_versions ADD CONSTRAINT job_versions_workspace_job_fk
      FOREIGN KEY (workspace_id, canonical_job_id)
      REFERENCES canonical_jobs (workspace_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'profile_versions'::regclass AND conname = 'profile_versions_workspace_candidate_fk') THEN
    ALTER TABLE profile_versions ADD CONSTRAINT profile_versions_workspace_candidate_fk
      FOREIGN KEY (workspace_id, candidate_profile_id)
      REFERENCES candidate_profiles (workspace_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'profile_facts'::regclass AND conname = 'profile_facts_workspace_version_fk') THEN
    ALTER TABLE profile_facts ADD CONSTRAINT profile_facts_workspace_version_fk
      FOREIGN KEY (workspace_id, profile_version_id)
      REFERENCES profile_versions (workspace_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'profile_credentials'::regclass AND conname = 'profile_credentials_workspace_version_fk') THEN
    ALTER TABLE profile_credentials ADD CONSTRAINT profile_credentials_workspace_version_fk
      FOREIGN KEY (workspace_id, profile_version_id)
      REFERENCES profile_versions (workspace_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'profile_engagements'::regclass AND conname = 'profile_engagements_workspace_version_fk') THEN
    ALTER TABLE profile_engagements ADD CONSTRAINT profile_engagements_workspace_version_fk
      FOREIGN KEY (workspace_id, profile_version_id)
      REFERENCES profile_versions (workspace_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'requirement_sets'::regclass AND conname = 'requirement_sets_workspace_job_version_fk') THEN
    ALTER TABLE requirement_sets ADD CONSTRAINT requirement_sets_workspace_job_version_fk
      FOREIGN KEY (workspace_id, canonical_job_id, job_version_id)
      REFERENCES job_versions (workspace_id, canonical_job_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'job_requirements'::regclass AND conname = 'job_requirements_workspace_set_fk') THEN
    ALTER TABLE job_requirements ADD CONSTRAINT job_requirements_workspace_set_fk
      FOREIGN KEY (workspace_id, canonical_job_id, job_version_id, requirement_set_id)
      REFERENCES requirement_sets (workspace_id, canonical_job_id, job_version_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS manual_application_fetch_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  requested_url TEXT NOT NULL CHECK (length(requested_url) BETWEEN 1 AND 2048),
  resolved_url TEXT NOT NULL CHECK (length(resolved_url) BETWEEN 1 AND 2048),
  canonical_url TEXT NOT NULL CHECK (length(canonical_url) BETWEEN 1 AND 2048),
  expected_title TEXT NOT NULL CHECK (length(expected_title) BETWEEN 2 AND 300),
  expected_company TEXT NOT NULL CHECK (length(expected_company) BETWEEN 1 AND 300),
  expected_requisition_id TEXT CHECK (expected_requisition_id IS NULL OR length(expected_requisition_id) <= 160),
  description_hash TEXT NOT NULL CHECK (description_hash ~ '^[a-f0-9]{64}$'),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  provider TEXT NOT NULL CHECK (provider IN ('ASHBY', 'GREENHOUSE', 'LEVER', 'EMPLOYER_WEBSITE')),
  source_evidence JSONB NOT NULL CHECK (jsonb_typeof(source_evidence) = 'object'),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 day'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT manual_application_fetch_receipts_membership_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_manual_application_fetch_receipts_scope
  ON manual_application_fetch_receipts (workspace_id, user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS manual_application_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  candidate_profile_id UUID NOT NULL,
  canonical_job_id UUID NOT NULL,
  job_version_id UUID NOT NULL,
  source_observation_id UUID NOT NULL,
  job_content_hash TEXT NOT NULL CHECK (length(job_content_hash) BETWEEN 1 AND 255),
  profile_version_id UUID NOT NULL,
  profile_contact_fact_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  profile_contact_fingerprint TEXT NOT NULL CHECK (profile_contact_fingerprint ~ '^[a-f0-9]{64}$'),
  preference_context_fingerprint TEXT NOT NULL CHECK (preference_context_fingerprint ~ '^[a-f0-9]{64}$'),
  requirement_set_id UUID NOT NULL,
  comparator_version TEXT NOT NULL CHECK (length(comparator_version) BETWEEN 1 AND 80),
  context_fingerprint TEXT NOT NULL CHECK (context_fingerprint ~ '^[a-f0-9]{64}$'),
  comparison_fingerprint TEXT NOT NULL CHECK (comparison_fingerprint ~ '^[a-f0-9]{64}$'),
  comparison_payload JSONB NOT NULL CHECK (jsonb_typeof(comparison_payload) = 'object'),
  suitability_warnings JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(suitability_warnings) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT manual_application_drafts_membership_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT manual_application_drafts_profile_fk
    FOREIGN KEY (workspace_id, candidate_profile_id, profile_version_id)
    REFERENCES profile_versions (workspace_id, candidate_profile_id, id) ON DELETE RESTRICT,
  CONSTRAINT manual_application_drafts_job_fk
    FOREIGN KEY (workspace_id, canonical_job_id, job_version_id)
    REFERENCES job_versions (workspace_id, canonical_job_id, id) ON DELETE RESTRICT,
  CONSTRAINT manual_application_drafts_source_fk
    FOREIGN KEY (workspace_id, source_observation_id, job_version_id)
    REFERENCES raw_job_observations (workspace_id, id, job_version_id) ON DELETE RESTRICT,
  CONSTRAINT manual_application_drafts_requirement_fk
    FOREIGN KEY (workspace_id, canonical_job_id, job_version_id, requirement_set_id)
    REFERENCES requirement_sets (workspace_id, canonical_job_id, job_version_id, id) ON DELETE RESTRICT,
  CONSTRAINT manual_application_drafts_comparison_id_context_key
    UNIQUE (workspace_id, user_id, id, candidate_profile_id, canonical_job_id, job_version_id,
      source_observation_id, job_content_hash, profile_version_id, profile_contact_fingerprint,
      profile_contact_fact_ids, preference_context_fingerprint, requirement_set_id, comparator_version, context_fingerprint,
      comparison_fingerprint),
  CONSTRAINT manual_application_drafts_contact_link_key
    UNIQUE (workspace_id, user_id, id, profile_version_id)
);

CREATE INDEX IF NOT EXISTS idx_manual_application_drafts_scope
  ON manual_application_drafts (workspace_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_manual_application_drafts_job_version
  ON manual_application_drafts (workspace_id, canonical_job_id, job_version_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_application_drafts_exact_comparison
  ON manual_application_drafts (workspace_id, user_id, comparison_fingerprint, profile_contact_fact_ids);

CREATE TABLE IF NOT EXISTS manual_application_draft_contact_facts (
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  draft_id UUID NOT NULL,
  profile_version_id UUID NOT NULL,
  profile_contact_fact_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id, draft_id, profile_version_id, profile_contact_fact_id),
  CONSTRAINT manual_application_draft_contact_facts_draft_fk
    FOREIGN KEY (workspace_id, user_id, draft_id, profile_version_id)
    REFERENCES manual_application_drafts (workspace_id, user_id, id, profile_version_id) ON DELETE RESTRICT,
  CONSTRAINT manual_application_draft_contact_facts_profile_fact_fk
    FOREIGN KEY (workspace_id, profile_version_id, profile_contact_fact_id)
    REFERENCES profile_facts (workspace_id, profile_version_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS manual_application_preparation_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  draft_id UUID NOT NULL,
  candidate_profile_id UUID NOT NULL,
  canonical_job_id UUID NOT NULL,
  job_version_id UUID NOT NULL,
  source_observation_id UUID NOT NULL,
  job_content_hash TEXT NOT NULL,
  profile_version_id UUID NOT NULL,
  profile_contact_fact_ids UUID[] NOT NULL,
  profile_contact_fingerprint TEXT NOT NULL CHECK (profile_contact_fingerprint ~ '^[a-f0-9]{64}$'),
  preference_context_fingerprint TEXT NOT NULL CHECK (preference_context_fingerprint ~ '^[a-f0-9]{64}$'),
  requirement_set_id UUID NOT NULL,
  comparator_version TEXT NOT NULL,
  context_fingerprint TEXT NOT NULL CHECK (context_fingerprint ~ '^[a-f0-9]{64}$'),
  comparison_fingerprint TEXT NOT NULL CHECK (comparison_fingerprint ~ '^[a-f0-9]{64}$'),
  approved BOOLEAN NOT NULL CHECK (approved IS TRUE),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT manual_application_approvals_membership_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT manual_application_approvals_comparison_context_fk
    FOREIGN KEY (workspace_id, user_id, draft_id, candidate_profile_id, canonical_job_id, job_version_id,
      source_observation_id, job_content_hash, profile_version_id, profile_contact_fingerprint,
      profile_contact_fact_ids, preference_context_fingerprint, requirement_set_id, comparator_version, context_fingerprint,
      comparison_fingerprint)
    REFERENCES manual_application_drafts (workspace_id, user_id, id, candidate_profile_id, canonical_job_id,
      job_version_id, source_observation_id, job_content_hash, profile_version_id, profile_contact_fingerprint,
      profile_contact_fact_ids, preference_context_fingerprint, requirement_set_id, comparator_version, context_fingerprint,
      comparison_fingerprint) ON DELETE RESTRICT,
  CONSTRAINT manual_application_approvals_identity_key UNIQUE (id, workspace_id, user_id),
  CONSTRAINT manual_application_approvals_contact_link_key
    UNIQUE (workspace_id, user_id, id, draft_id, profile_version_id),
  CONSTRAINT manual_application_approvals_full_context_key
    UNIQUE (workspace_id, user_id, id, candidate_profile_id, canonical_job_id, job_version_id,
      source_observation_id, job_content_hash, profile_version_id, profile_contact_fact_ids,
      profile_contact_fingerprint, preference_context_fingerprint, requirement_set_id, comparator_version,
      context_fingerprint, comparison_fingerprint),
  CONSTRAINT manual_application_approvals_exact_once_key
    UNIQUE (workspace_id, user_id, draft_id, comparison_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_manual_preparation_approvals_scope
  ON manual_application_preparation_approvals (workspace_id, user_id, draft_id, approved_at DESC);

CREATE TABLE IF NOT EXISTS manual_application_approval_contact_facts (
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  approval_id UUID NOT NULL,
  draft_id UUID NOT NULL,
  profile_version_id UUID NOT NULL,
  profile_contact_fact_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id, approval_id, draft_id, profile_version_id, profile_contact_fact_id),
  CONSTRAINT manual_application_approval_contact_facts_approval_fk
    FOREIGN KEY (workspace_id, user_id, approval_id, draft_id, profile_version_id)
    REFERENCES manual_application_preparation_approvals (workspace_id, user_id, id, draft_id, profile_version_id) ON DELETE RESTRICT,
  CONSTRAINT manual_application_approval_contact_facts_draft_fk
    FOREIGN KEY (workspace_id, user_id, draft_id, profile_version_id, profile_contact_fact_id)
    REFERENCES manual_application_draft_contact_facts (workspace_id, user_id, draft_id, profile_version_id, profile_contact_fact_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS manual_application_document_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  approval_id UUID NOT NULL,
  canonical_job_id UUID NOT NULL,
  job_version_id UUID NOT NULL,
  source_observation_id UUID NOT NULL,
  job_content_hash TEXT NOT NULL,
  candidate_profile_id UUID NOT NULL,
  profile_version_id UUID NOT NULL,
  profile_contact_fact_ids UUID[] NOT NULL,
  profile_contact_fingerprint TEXT NOT NULL,
  preference_context_fingerprint TEXT NOT NULL,
  requirement_set_id UUID NOT NULL,
  comparator_version TEXT NOT NULL,
  context_fingerprint TEXT NOT NULL,
  comparison_fingerprint TEXT NOT NULL,
  document_type TEXT NOT NULL CHECK (document_type IN ('CV', 'COVER_LETTER')),
  status TEXT NOT NULL CHECK (status = 'COMPLETED'),
  generator_version TEXT NOT NULL,
  output_manifest JSONB NOT NULL CHECK (jsonb_typeof(output_manifest) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT manual_application_document_runs_approval_context_fk
    FOREIGN KEY (workspace_id, user_id, approval_id, candidate_profile_id, canonical_job_id, job_version_id,
      source_observation_id, job_content_hash, profile_version_id, profile_contact_fact_ids,
      profile_contact_fingerprint, preference_context_fingerprint, requirement_set_id, comparator_version,
      context_fingerprint, comparison_fingerprint)
    REFERENCES manual_application_preparation_approvals (workspace_id, user_id, id, candidate_profile_id,
      canonical_job_id, job_version_id, source_observation_id, job_content_hash, profile_version_id,
      profile_contact_fact_ids, profile_contact_fingerprint, preference_context_fingerprint, requirement_set_id,
      comparator_version, context_fingerprint, comparison_fingerprint) ON DELETE RESTRICT,
  CONSTRAINT manual_application_document_runs_one_per_type UNIQUE (approval_id, document_type),
  CONSTRAINT manual_application_document_runs_scope UNIQUE (id, workspace_id, user_id, approval_id, document_type),
  CONSTRAINT manual_application_document_runs_workspace_scope UNIQUE (id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_manual_document_runs_scope
  ON manual_application_document_runs (workspace_id, user_id, approval_id, document_type);

CREATE TABLE IF NOT EXISTS manual_application_document_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  manual_document_run_id UUID NOT NULL,
  section_label TEXT NOT NULL CHECK (length(section_label) > 0),
  claim_text TEXT NOT NULL CHECK (length(claim_text) > 0),
  evidence_ids TEXT[] NOT NULL CHECK (cardinality(evidence_ids) > 0),
  requirement_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT manual_application_document_claims_run_fk
    FOREIGN KEY (manual_document_run_id, workspace_id)
    REFERENCES manual_application_document_runs (id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_manual_document_claims_run
  ON manual_application_document_claims (workspace_id, manual_document_run_id);

CREATE TABLE IF NOT EXISTS manual_application_document_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  approval_id UUID NOT NULL,
  document_run_id UUID NOT NULL,
  document_type TEXT NOT NULL CHECK (document_type IN ('CV', 'COVER_LETTER')),
  format TEXT NOT NULL CHECK (format IN ('DOCX', 'PDF')),
  filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 160),
  mime_type TEXT NOT NULL CHECK (mime_type IN (
    'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  content BYTEA NOT NULL CHECK (octet_length(content) > 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT manual_application_document_artifacts_run_fk
    FOREIGN KEY (document_run_id, workspace_id, user_id, approval_id, document_type)
    REFERENCES manual_application_document_runs (id, workspace_id, user_id, approval_id, document_type) ON DELETE RESTRICT,
  CONSTRAINT manual_application_document_artifacts_unique_format UNIQUE (approval_id, document_type, format)
);

CREATE INDEX IF NOT EXISTS idx_manual_document_artifacts_scope
  ON manual_application_document_artifacts (workspace_id, user_id, approval_id);

COMMENT ON TABLE manual_application_drafts IS
  'Private, exact-version profile comparison created only by an explicit manual user flow.';
COMMENT ON TABLE manual_application_preparation_approvals IS
  'Explicit user approval pinned to a single comparison and its complete source/profile/policy context.';
COMMENT ON TABLE manual_application_document_artifacts IS
  'Private document bytes; accessible only through authenticated workspace and approval checks.';
