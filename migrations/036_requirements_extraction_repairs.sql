-- Migration 036: Requirements extraction schema repairs
--
-- This migration is intentionally defensive: earlier databases may have recorded
-- 024_* as applied under a different file body, leaving runtime code (requirements
-- extractor / deterministic matcher / document generators) expecting tables or
-- columns that do not exist.
--
-- Goals:
-- - Ensure requirement-set tables exist (identities + sets).
-- - Ensure requirement_set_id + active_requirement_set_id columns exist.
-- - Ensure required uniqueness/indexes exist for INSERT ... ON CONFLICT paths.
-- - Repair legacy rows where active_requirement_set_id is set but no requirement
--   rows are linked, preventing downstream matching.

-- ----------------------------------------------------------------------------
-- 1) Requirement-set tables (create if missing)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS requirement_set_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
  identity_hash TEXT NOT NULL,
  schema_version TEXT NOT NULL DEFAULT '2.2.0',
  job_content_hash TEXT NOT NULL,
  deterministic_extractor_version TEXT NOT NULL,
  quoted_extractor_version TEXT NOT NULL,
  quoted_prompt_hash TEXT NOT NULL,
  normalizer_hash TEXT NOT NULL,
  quoted_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS requirement_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requirement_identity_id UUID NOT NULL REFERENCES requirement_set_identities(id) ON DELETE CASCADE,
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
  job_version_id UUID NOT NULL REFERENCES job_versions(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  source_type TEXT NOT NULL CHECK (source_type IN ('EXTRACTED', 'CORRECTED')),
  base_requirement_set_id UUID REFERENCES requirement_sets(id) ON DELETE SET NULL,
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure identity columns exist even if the table was created in an older variant.
ALTER TABLE requirement_set_identities
  ADD COLUMN IF NOT EXISTS schema_version TEXT NOT NULL DEFAULT '2.2.0';
ALTER TABLE requirement_set_identities
  ADD COLUMN IF NOT EXISTS job_content_hash TEXT;
ALTER TABLE requirement_set_identities
  ADD COLUMN IF NOT EXISTS deterministic_extractor_version TEXT;
ALTER TABLE requirement_set_identities
  ADD COLUMN IF NOT EXISTS quoted_extractor_version TEXT;
ALTER TABLE requirement_set_identities
  ADD COLUMN IF NOT EXISTS quoted_prompt_hash TEXT;
ALTER TABLE requirement_set_identities
  ADD COLUMN IF NOT EXISTS normalizer_hash TEXT;
ALTER TABLE requirement_set_identities
  ADD COLUMN IF NOT EXISTS quoted_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE requirement_set_identities
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ----------------------------------------------------------------------------
-- 2) Required columns for runtime joins (add if missing)
-- ----------------------------------------------------------------------------

ALTER TABLE job_versions
  ADD COLUMN IF NOT EXISTS active_requirement_set_id UUID;

ALTER TABLE requirement_extraction_runs
  ADD COLUMN IF NOT EXISTS requirement_set_id UUID;

ALTER TABLE job_requirements
  ADD COLUMN IF NOT EXISTS requirement_set_id UUID;

CREATE INDEX IF NOT EXISTS idx_job_requirements_requirement_set_id
  ON job_requirements(requirement_set_id);

-- ----------------------------------------------------------------------------
-- 3) Foreign keys (add if missing)
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_job_versions_active_requirement_set'
  ) THEN
    ALTER TABLE job_versions
      ADD CONSTRAINT fk_job_versions_active_requirement_set
      FOREIGN KEY (active_requirement_set_id) REFERENCES requirement_sets(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_requirement_extraction_runs_requirement_set'
  ) THEN
    ALTER TABLE requirement_extraction_runs
      ADD CONSTRAINT fk_requirement_extraction_runs_requirement_set
      FOREIGN KEY (requirement_set_id) REFERENCES requirement_sets(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_job_requirements_requirement_set'
  ) THEN
    ALTER TABLE job_requirements
      ADD CONSTRAINT fk_job_requirements_requirement_set
      FOREIGN KEY (requirement_set_id) REFERENCES requirement_sets(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 4) Uniqueness/indexes required by requirementsExtractor INSERT ... ON CONFLICT
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT tc.constraint_name INTO constraint_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name
   AND kcu.table_schema = tc.table_schema
   AND kcu.table_name = tc.table_name
  WHERE tc.table_schema = 'public'
    AND tc.table_name = 'requirement_set_identities'
    AND tc.constraint_type = 'UNIQUE'
  GROUP BY tc.constraint_name
  HAVING array_agg(kcu.column_name::text ORDER BY kcu.ordinal_position)
    = ARRAY['workspace_id', 'canonical_job_id', 'identity_hash']::text[];

  IF constraint_name IS NULL THEN
    BEGIN
      ALTER TABLE requirement_set_identities
        ADD CONSTRAINT requirement_set_identities_workspace_canonical_identity_hash_key
        UNIQUE (workspace_id, canonical_job_id, identity_hash);
    EXCEPTION WHEN duplicate_object THEN
      -- ignore
    END;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_requirements_set_requirement_key
  ON job_requirements (requirement_set_id, requirement_key);

-- ----------------------------------------------------------------------------
-- 5) Legacy repair: link requirement rows/runs to active requirement set when present
-- ----------------------------------------------------------------------------

-- job_requirements becomes immutable after 024_* (trigger-based guard), so do not UPDATE it here.
-- Instead, if an active_requirement_set_id is set but has zero linked requirements, clear it so
-- downstream queries fall back to job_version_id joins instead of returning zero rows.
UPDATE job_versions jv
SET active_requirement_set_id = NULL
WHERE jv.active_requirement_set_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM job_requirements jr
    WHERE jr.workspace_id = jv.workspace_id
      AND jr.job_version_id = jv.id
      AND jr.status = 'VALIDATED'
      AND jr.requirement_set_id = jv.active_requirement_set_id
  );
