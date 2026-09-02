-- Migration 016: Document provenance ledger
--
-- Tracks generated CV/Cover Letter artifacts with claim-to-evidence lineage.

BEGIN;

CREATE TABLE IF NOT EXISTS document_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
    job_version_id UUID NOT NULL REFERENCES job_versions(id) ON DELETE CASCADE,
    match_run_id UUID REFERENCES match_runs(id) ON DELETE SET NULL,
    document_type TEXT NOT NULL CHECK (document_type IN ('CV', 'COVER_LETTER')),
    status TEXT NOT NULL CHECK (status IN ('STARTED', 'COMPLETED', 'FAILED')),
    policy_version TEXT NOT NULL,
    generator_version TEXT NOT NULL,
    output_manifest JSONB NOT NULL,
    claim_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_document_runs_job_version
  ON document_runs(job_version_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_document_runs_type
  ON document_runs(document_type, created_at DESC);

CREATE TABLE IF NOT EXISTS document_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_run_id UUID NOT NULL REFERENCES document_runs(id) ON DELETE CASCADE,
    section_label TEXT NOT NULL,
    claim_text TEXT NOT NULL,
    profile_fact_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    requirement_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    unresolved_requirement_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_claims_run
  ON document_claims(document_run_id);

COMMENT ON TABLE document_runs IS
  'Document generation runs with immutable output manifests and provenance policy metadata.';

COMMENT ON TABLE document_claims IS
  'Claim-level evidence lineage from generated document text to profile fact ids and job requirement ids.';

COMMIT;
