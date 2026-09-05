-- Migration 024: Requirement sets and correction workflow
--
-- Goals (IDE Closeout Pack P5):
-- 1) Immutable requirement set identities keyed by job-text + extractor + prompt + normalizer hashes.
-- 2) Persist immutable requirement set revisions; corrections create new revisions (never overwrite).
-- 3) Activation events preserve history and support downstream re-processing.
--
-- Notes:
-- - Additive; does not delete historical requirement rows.
-- - Backfills existing job_requirements into a first requirement_set per job_version.

BEGIN;

-- ============================================================================
-- 1) Identity registry (cache key)
-- ============================================================================

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, canonical_job_id, identity_hash)
);

CREATE INDEX IF NOT EXISTS idx_requirement_set_identities_workspace
  ON requirement_set_identities(workspace_id);
CREATE INDEX IF NOT EXISTS idx_requirement_set_identities_canonical
  ON requirement_set_identities(canonical_job_id);

-- ============================================================================
-- 2) Immutable requirement sets (revisions)
-- ============================================================================

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_version_id, revision_number)
);

CREATE INDEX IF NOT EXISTS idx_requirement_sets_workspace
  ON requirement_sets(workspace_id);
CREATE INDEX IF NOT EXISTS idx_requirement_sets_job_version
  ON requirement_sets(job_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requirement_sets_identity
  ON requirement_sets(requirement_identity_id, created_at DESC);

-- ============================================================================
-- 3) Requirement set operations + activation events (audit)
-- ============================================================================

CREATE TABLE IF NOT EXISTS requirement_set_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requirement_set_id UUID NOT NULL REFERENCES requirement_sets(id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('ADD', 'REVISE', 'RETIRE', 'RECLASSIFY')),
  target_requirement_key TEXT,
  payload JSONB NOT NULL,
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_requirement_set_operations_requirement_set
  ON requirement_set_operations(requirement_set_id, created_at DESC);

CREATE TABLE IF NOT EXISTS requirement_set_activation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
  job_version_id UUID NOT NULL REFERENCES job_versions(id) ON DELETE CASCADE,
  from_requirement_set_id UUID REFERENCES requirement_sets(id) ON DELETE SET NULL,
  to_requirement_set_id UUID REFERENCES requirement_sets(id) ON DELETE RESTRICT,
  activated_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_requirement_set_activation_events_job_version
  ON requirement_set_activation_events(job_version_id, activated_at DESC);

-- ============================================================================
-- 4) Link job_versions + runs + requirements to requirement sets
-- ============================================================================

ALTER TABLE job_versions
  ADD COLUMN IF NOT EXISTS active_requirement_set_id UUID;

ALTER TABLE job_versions
  ADD CONSTRAINT fk_job_versions_active_requirement_set
  FOREIGN KEY (active_requirement_set_id) REFERENCES requirement_sets(id) ON DELETE SET NULL;

ALTER TABLE requirement_extraction_runs
  ADD COLUMN IF NOT EXISTS requirement_set_id UUID;

ALTER TABLE requirement_extraction_runs
  ADD CONSTRAINT fk_requirement_extraction_runs_requirement_set
  FOREIGN KEY (requirement_set_id) REFERENCES requirement_sets(id) ON DELETE SET NULL;

ALTER TABLE job_requirements
  ADD COLUMN IF NOT EXISTS requirement_set_id UUID;

ALTER TABLE job_requirements
  ADD CONSTRAINT fk_job_requirements_requirement_set
  FOREIGN KEY (requirement_set_id) REFERENCES requirement_sets(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_job_requirements_requirement_set_id
  ON job_requirements(requirement_set_id);

-- ============================================================================
-- 5) Backfill: create requirement_set identity + first set per existing job_version
-- ============================================================================

-- Hash constants (must match src/pipeline/requirementsExtractor.ts)
-- - quoted_prompt_hash: sha256("quoted_prompt_v1|schema_version:2.2.0")
-- - normalizer_hash:   sha256("requirements_normalizer_v1")
WITH targets AS (
  SELECT DISTINCT
    jr.workspace_id,
    jr.canonical_job_id,
    jr.job_version_id
  FROM job_requirements jr
  WHERE jr.requirement_set_id IS NULL
),
meta AS (
  SELECT
    t.workspace_id,
    t.canonical_job_id,
    t.job_version_id,
    COALESCE(jv.content_hash, md5(COALESCE(jv.description_text, ''))) AS job_content_hash,
    COALESCE(
      (SELECT MAX(jr2.extractor_version)
       FROM job_requirements jr2
       WHERE jr2.workspace_id = t.workspace_id
         AND jr2.job_version_id = t.job_version_id
         AND jr2.extractor_type = 'DETERMINISTIC'),
      'deterministic_v1'
    ) AS deterministic_extractor_version,
    COALESCE(
      (SELECT MAX(jr3.extractor_version)
       FROM job_requirements jr3
       WHERE jr3.workspace_id = t.workspace_id
         AND jr3.job_version_id = t.job_version_id
         AND jr3.extractor_type = 'LLM_QUOTED'),
      'none'
    ) AS quoted_extractor_version,
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM job_requirements jr4
        WHERE jr4.workspace_id = t.workspace_id
          AND jr4.job_version_id = t.job_version_id
          AND jr4.extractor_type = 'LLM_QUOTED'
      ) THEN TRUE
      ELSE FALSE
    END AS quoted_enabled,
    encode(digest('quoted_prompt_v1|schema_version:2.2.0', 'sha256'), 'hex') AS quoted_prompt_hash,
    encode(digest('requirements_normalizer_v1', 'sha256'), 'hex') AS normalizer_hash
  FROM targets t
  JOIN job_versions jv
    ON jv.workspace_id = t.workspace_id
   AND jv.id = t.job_version_id
),
identity_rows AS (
  SELECT
    m.*,
    encode(
      digest(
        m.job_content_hash || '|' ||
        m.deterministic_extractor_version || '|' ||
        m.quoted_extractor_version || '|' ||
        m.quoted_prompt_hash || '|' ||
        m.normalizer_hash || '|' ||
        CASE WHEN m.quoted_enabled THEN '1' ELSE '0' END,
        'sha256'
      ),
      'hex'
    ) AS identity_hash
  FROM meta m
),
upserted_identities AS (
  INSERT INTO requirement_set_identities (
    workspace_id,
    canonical_job_id,
    identity_hash,
    job_content_hash,
    deterministic_extractor_version,
    quoted_extractor_version,
    quoted_prompt_hash,
    normalizer_hash,
    quoted_enabled,
    created_at
  )
  SELECT
    ir.workspace_id,
    ir.canonical_job_id,
    ir.identity_hash,
    ir.job_content_hash,
    ir.deterministic_extractor_version,
    ir.quoted_extractor_version,
    ir.quoted_prompt_hash,
    ir.normalizer_hash,
    ir.quoted_enabled,
    NOW()
  FROM identity_rows ir
  ON CONFLICT (workspace_id, canonical_job_id, identity_hash) DO NOTHING
  RETURNING id, workspace_id, canonical_job_id, identity_hash
),
resolved_identities AS (
  SELECT
    rsi.id AS requirement_identity_id,
    ir.workspace_id,
    ir.canonical_job_id,
    ir.job_version_id
  FROM identity_rows ir
  JOIN requirement_set_identities rsi
    ON rsi.workspace_id = ir.workspace_id
   AND rsi.canonical_job_id = ir.canonical_job_id
   AND rsi.identity_hash = ir.identity_hash
),
inserted_sets AS (
  INSERT INTO requirement_sets (
    workspace_id,
    requirement_identity_id,
    canonical_job_id,
    job_version_id,
    revision_number,
    source_type,
    base_requirement_set_id,
    created_by_user_id,
    created_at
  )
  SELECT
    ri.workspace_id,
    ri.requirement_identity_id,
    ri.canonical_job_id,
    ri.job_version_id,
    1,
    'EXTRACTED',
    NULL,
    jdec_default_user_id(),
    NOW()
  FROM resolved_identities ri
  ON CONFLICT (job_version_id, revision_number) DO NOTHING
  RETURNING id, workspace_id, job_version_id
),
resolved_sets AS (
  SELECT id, workspace_id, job_version_id FROM inserted_sets
  UNION
  SELECT rs.id, rs.workspace_id, rs.job_version_id
  FROM requirement_sets rs
  JOIN resolved_identities ri
    ON ri.workspace_id = rs.workspace_id
   AND ri.job_version_id = rs.job_version_id
  WHERE rs.revision_number = 1
)
UPDATE job_versions jv
SET active_requirement_set_id = rs.id
FROM resolved_sets rs
WHERE jv.workspace_id = rs.workspace_id
  AND jv.id = rs.job_version_id
  AND jv.active_requirement_set_id IS NULL;

-- Link job_requirements rows to the backfilled set.
UPDATE job_requirements jr
SET requirement_set_id = rs.id
FROM requirement_sets rs
WHERE rs.workspace_id = jr.workspace_id
  AND rs.job_version_id = jr.job_version_id
  AND rs.revision_number = 1
  AND jr.requirement_set_id IS NULL;

-- Link extraction runs to the backfilled set (best-effort).
UPDATE requirement_extraction_runs rer
SET requirement_set_id = rs.id
FROM requirement_sets rs
WHERE rs.workspace_id = rer.workspace_id
  AND rs.job_version_id = rer.job_version_id
  AND rs.revision_number = 1
  AND rer.requirement_set_id IS NULL;

-- Enforce requirement_set_id is present for all persisted requirements.
UPDATE job_requirements
SET requirement_set_id = (
  SELECT rs.id
  FROM requirement_sets rs
  WHERE rs.workspace_id = job_requirements.workspace_id
    AND rs.job_version_id = job_requirements.job_version_id
  ORDER BY rs.revision_number ASC
  LIMIT 1
)
WHERE requirement_set_id IS NULL;

ALTER TABLE job_requirements
  ALTER COLUMN requirement_set_id SET NOT NULL;

-- Replace per-job-version requirement_key uniqueness with per-requirement-set uniqueness.
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
    AND tc.table_name = 'job_requirements'
    AND tc.constraint_type = 'UNIQUE'
  GROUP BY tc.constraint_name
  HAVING array_agg(kcu.column_name ORDER BY kcu.ordinal_position) = ARRAY['job_version_id','requirement_key'];

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE job_requirements DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_requirements_set_requirement_key
  ON job_requirements (requirement_set_id, requirement_key);

-- ============================================================================
-- 6) Immutability guards (never overwrite requirement history)
-- ============================================================================

CREATE OR REPLACE FUNCTION requirement_sets_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'requirement_sets rows are immutable; insert a new requirement_set revision instead.';
END
$$;

DROP TRIGGER IF EXISTS trg_requirement_sets_immutable ON requirement_sets;
CREATE TRIGGER trg_requirement_sets_immutable
BEFORE UPDATE OR DELETE ON requirement_sets
FOR EACH ROW EXECUTE FUNCTION requirement_sets_immutable_guard();

CREATE OR REPLACE FUNCTION job_requirements_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'job_requirements rows are immutable; insert new rows under a new requirement_set_id instead.';
END
$$;

DROP TRIGGER IF EXISTS trg_job_requirements_immutable ON job_requirements;
CREATE TRIGGER trg_job_requirements_immutable
BEFORE UPDATE OR DELETE ON job_requirements
FOR EACH ROW EXECUTE FUNCTION job_requirements_immutable_guard();

COMMIT;

