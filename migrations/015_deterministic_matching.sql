-- Migration 015: Deterministic requirement-to-evidence matching
--
-- Adds immutable match run artifacts and per-requirement evidence mappings.

BEGIN;

CREATE TABLE IF NOT EXISTS match_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
    job_version_id UUID NOT NULL REFERENCES job_versions(id) ON DELETE CASCADE,
    profile_version_id UUID NOT NULL REFERENCES profile_versions(id) ON DELETE RESTRICT,
    embedding_space_id UUID REFERENCES embedding_spaces(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('STARTED', 'COMPLETED', 'FAILED')),
    requirement_count INTEGER NOT NULL DEFAULT 0,
    matched_count INTEGER NOT NULL DEFAULT 0,
    coverage_score NUMERIC(5,2) NOT NULL DEFAULT 0,
    overall_match_score NUMERIC(5,2) NOT NULL DEFAULT 0,
    policy_version TEXT NOT NULL DEFAULT 'deterministic_v1',
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_match_runs_job_version
  ON match_runs(job_version_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_match_runs_profile_version
  ON match_runs(profile_version_id, started_at DESC);

CREATE TABLE IF NOT EXISTS requirement_evidence_matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_run_id UUID NOT NULL REFERENCES match_runs(id) ON DELETE CASCADE,
    requirement_id UUID NOT NULL REFERENCES job_requirements(id) ON DELETE CASCADE,
    profile_fact_id UUID REFERENCES profile_facts(id) ON DELETE SET NULL,
    match_type TEXT NOT NULL CHECK (match_type IN ('EXACT', 'SEMANTIC', 'NO_MATCH', 'UNKNOWN')),
    match_score NUMERIC(5,4) NOT NULL DEFAULT 0,
    rationale TEXT,
    evidence JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (match_run_id, requirement_id)
);

CREATE INDEX IF NOT EXISTS idx_req_evidence_matches_run
  ON requirement_evidence_matches(match_run_id);

CREATE INDEX IF NOT EXISTS idx_req_evidence_matches_requirement
  ON requirement_evidence_matches(requirement_id);

ALTER TABLE canonical_jobs
  ADD COLUMN IF NOT EXISTS deterministic_match_score NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS deterministic_match_coverage NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS latest_match_run_id UUID REFERENCES match_runs(id) ON DELETE SET NULL;

COMMENT ON TABLE match_runs IS
  'Deterministic profile-vs-requirements match snapshots for each job version.';

COMMENT ON TABLE requirement_evidence_matches IS
  'Per requirement best-match evidence link to profile facts with deterministic score.';

COMMIT;
