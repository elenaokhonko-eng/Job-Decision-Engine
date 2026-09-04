-- Migration 021: Stable profile fact identities + immutable revisions + version snapshots
--
-- Goals (IDE Closeout Pack P2):
-- 1) Stable fact identities (per workspace + candidate profile + fact_key).
-- 2) Immutable fact revisions (insert-only) with approval/activation recorded separately.
-- 3) Pinned profile-version snapshots that reference stable identities + revisions.
--
-- Notes:
-- - Additive and reversible (no drops of user data).
-- - Backfill creates revision records for existing profile_facts rows.

BEGIN;

-- ============================================================================
-- 1) Stable identities
-- ============================================================================

CREATE TABLE IF NOT EXISTS profile_fact_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  candidate_profile_id UUID NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  fact_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, candidate_profile_id, fact_key)
);

CREATE INDEX IF NOT EXISTS idx_profile_fact_identities_workspace ON profile_fact_identities(workspace_id);
CREATE INDEX IF NOT EXISTS idx_profile_fact_identities_candidate ON profile_fact_identities(candidate_profile_id);

-- ============================================================================
-- 2) Immutable revisions (approval + activation are separate)
-- ============================================================================

CREATE TABLE IF NOT EXISTS profile_fact_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fact_identity_id UUID NOT NULL REFERENCES profile_fact_identities(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  schema_version TEXT NOT NULL DEFAULT '2.2.0',
  content_hash TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  statement TEXT NOT NULL,
  structured_value JSONB,
  evidence_tier TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  start_date DATE,
  end_date DATE,
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  confidentiality TEXT NOT NULL,
  source_profile_fact_id UUID,
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (fact_identity_id, revision_number),
  UNIQUE (fact_identity_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_profile_fact_revisions_identity ON profile_fact_revisions(fact_identity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_fact_revisions_workspace ON profile_fact_revisions(workspace_id);

CREATE OR REPLACE FUNCTION profile_fact_revisions_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'profile_fact_revisions rows are immutable; insert a new revision instead.';
END
$$;

DROP TRIGGER IF EXISTS trg_profile_fact_revisions_immutable ON profile_fact_revisions;
CREATE TRIGGER trg_profile_fact_revisions_immutable
BEFORE UPDATE OR DELETE ON profile_fact_revisions
FOR EACH ROW EXECUTE FUNCTION profile_fact_revisions_immutable_guard();

CREATE TABLE IF NOT EXISTS profile_fact_revision_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fact_revision_id UUID NOT NULL REFERENCES profile_fact_revisions(id) ON DELETE CASCADE,
  approved_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (fact_revision_id)
);

CREATE INDEX IF NOT EXISTS idx_profile_fact_revision_approvals_workspace ON profile_fact_revision_approvals(workspace_id);

CREATE TABLE IF NOT EXISTS profile_fact_active_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fact_identity_id UUID NOT NULL REFERENCES profile_fact_identities(id) ON DELETE CASCADE,
  fact_revision_id UUID NOT NULL REFERENCES profile_fact_revisions(id) ON DELETE RESTRICT,
  activated_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (fact_identity_id)
);

CREATE INDEX IF NOT EXISTS idx_profile_fact_active_revisions_workspace ON profile_fact_active_revisions(workspace_id);

CREATE TABLE IF NOT EXISTS profile_fact_activation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fact_identity_id UUID NOT NULL REFERENCES profile_fact_identities(id) ON DELETE CASCADE,
  from_revision_id UUID REFERENCES profile_fact_revisions(id) ON DELETE SET NULL,
  to_revision_id UUID REFERENCES profile_fact_revisions(id) ON DELETE SET NULL,
  activated_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_profile_fact_activation_events_identity
  ON profile_fact_activation_events(fact_identity_id, activated_at DESC);

-- ============================================================================
-- 3) Profile-version snapshots (pinned identity+revision)
-- ============================================================================

CREATE TABLE IF NOT EXISTS profile_version_fact_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_version_id UUID NOT NULL REFERENCES profile_versions(id) ON DELETE CASCADE,
  fact_identity_id UUID NOT NULL REFERENCES profile_fact_identities(id) ON DELETE CASCADE,
  fact_revision_id UUID NOT NULL REFERENCES profile_fact_revisions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_version_id, fact_identity_id)
);

CREATE INDEX IF NOT EXISTS idx_profile_version_fact_snapshots_workspace ON profile_version_fact_snapshots(workspace_id);
CREATE INDEX IF NOT EXISTS idx_profile_version_fact_snapshots_profile_version ON profile_version_fact_snapshots(profile_version_id);

-- ============================================================================
-- 4) Backfill from legacy profile_facts (preserve existing behavior)
-- ============================================================================

-- Add linkage columns on profile_facts for parity + downstream compatibility.
ALTER TABLE profile_facts
  ADD COLUMN IF NOT EXISTS fact_identity_id UUID,
  ADD COLUMN IF NOT EXISTS fact_revision_id UUID;

-- Identities: one per (workspace, candidate profile, fact_key).
INSERT INTO profile_fact_identities (workspace_id, candidate_profile_id, fact_key)
SELECT DISTINCT
  pv.workspace_id,
  pv.candidate_profile_id,
  pf.fact_key
FROM profile_facts pf
JOIN profile_versions pv ON pv.id = pf.profile_version_id
WHERE pf.fact_key IS NOT NULL
ON CONFLICT (workspace_id, candidate_profile_id, fact_key) DO NOTHING;

-- Revisions: one per existing profile_fact row (ordered per identity).
WITH base AS (
  SELECT
    pf.id AS profile_fact_id,
    pv.workspace_id,
    pfi.id AS fact_identity_id,
    ROW_NUMBER() OVER (
      PARTITION BY pfi.id
      ORDER BY pf.created_at ASC, pf.id ASC
    ) AS revision_number,
    md5(
      COALESCE(pf.fact_type, '') || '|' ||
      COALESCE(pf.statement, '') || '|' ||
      COALESCE(pf.evidence_tier, '') || '|' ||
      COALESCE(pf.verification_status, '') || '|' ||
      COALESCE(pf.confidentiality, '') || '|' ||
      COALESCE(pf.structured_value::text, '')
    ) AS content_hash,
    pf.fact_type,
    pf.statement,
    pf.structured_value,
    pf.evidence_tier,
    pf.verification_status,
    pf.start_date,
    pf.end_date,
    pf.is_current,
    pf.confidentiality,
    pf.created_at
  FROM profile_facts pf
  JOIN profile_versions pv ON pv.id = pf.profile_version_id
  JOIN profile_fact_identities pfi
    ON pfi.workspace_id = pv.workspace_id
   AND pfi.candidate_profile_id = pv.candidate_profile_id
   AND pfi.fact_key = pf.fact_key
)
INSERT INTO profile_fact_revisions (
  workspace_id,
  fact_identity_id,
  revision_number,
  content_hash,
  fact_type,
  statement,
  structured_value,
  evidence_tier,
  verification_status,
  start_date,
  end_date,
  is_current,
  confidentiality,
  source_profile_fact_id,
  created_at
)
SELECT
  base.workspace_id,
  base.fact_identity_id,
  base.revision_number,
  base.content_hash,
  base.fact_type,
  base.statement,
  base.structured_value,
  base.evidence_tier,
  base.verification_status,
  base.start_date,
  base.end_date,
  base.is_current,
  base.confidentiality,
  base.profile_fact_id,
  COALESCE(base.created_at, NOW())
FROM base
ON CONFLICT (fact_identity_id, content_hash) DO NOTHING;

	-- Link profile_facts rows to identities+revisions.
	UPDATE profile_facts pf
	SET fact_identity_id = pfi.id
	FROM profile_versions pv,
	     profile_fact_identities pfi
	WHERE pv.id = pf.profile_version_id
	  AND pfi.workspace_id = pv.workspace_id
	  AND pfi.candidate_profile_id = pv.candidate_profile_id
	  AND pfi.fact_key = pf.fact_key
	  AND pf.fact_identity_id IS NULL;

UPDATE profile_facts pf
SET fact_revision_id = pfr.id
FROM profile_fact_revisions pfr
WHERE pfr.source_profile_fact_id = pf.id
  AND pf.fact_revision_id IS NULL;

-- If multiple profile_facts map to the same content_hash (deduped revision),
-- fall back to identity + content_hash mapping.
	UPDATE profile_facts pf
	SET fact_revision_id = pfr.id
	FROM profile_versions pv,
	     profile_fact_identities pfi,
	     profile_fact_revisions pfr
	WHERE pv.id = pf.profile_version_id
	  AND pfi.workspace_id = pv.workspace_id
	  AND pfi.candidate_profile_id = pv.candidate_profile_id
	  AND pfi.fact_key = pf.fact_key
	  AND pfr.fact_identity_id = pfi.id
	  AND pfr.content_hash = md5(
	      COALESCE(pf.fact_type, '') || '|' ||
	      COALESCE(pf.statement, '') || '|' ||
	      COALESCE(pf.evidence_tier, '') || '|' ||
	      COALESCE(pf.verification_status, '') || '|' ||
	      COALESCE(pf.confidentiality, '') || '|' ||
	      COALESCE(pf.structured_value::text, '')
	    )
	  AND pf.fact_revision_id IS NULL;

-- Snapshot mapping for each profile version.
INSERT INTO profile_version_fact_snapshots (
  workspace_id,
  profile_version_id,
  fact_identity_id,
  fact_revision_id,
  created_at
)
SELECT
  pv.workspace_id,
  pf.profile_version_id,
  pf.fact_identity_id,
  pf.fact_revision_id,
  COALESCE(pf.created_at, NOW())
FROM profile_facts pf
JOIN profile_versions pv ON pv.id = pf.profile_version_id
WHERE pf.fact_identity_id IS NOT NULL
  AND pf.fact_revision_id IS NOT NULL
ON CONFLICT (profile_version_id, fact_identity_id) DO NOTHING;

-- Best-effort: set active revision per identity to latest created revision.
INSERT INTO profile_fact_active_revisions (
  workspace_id,
  fact_identity_id,
  fact_revision_id,
  activated_by_user_id,
  activated_at
)
SELECT
  pfi.workspace_id,
  pfi.id,
  pfr_latest.id,
  jdec_default_user_id(),
  NOW()
FROM profile_fact_identities pfi
JOIN LATERAL (
  SELECT id
  FROM profile_fact_revisions
  WHERE fact_identity_id = pfi.id
  ORDER BY revision_number DESC
  LIMIT 1
) pfr_latest ON TRUE
ON CONFLICT (fact_identity_id) DO NOTHING;

COMMIT;
