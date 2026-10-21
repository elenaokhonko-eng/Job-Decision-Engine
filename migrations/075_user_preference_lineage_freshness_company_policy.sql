-- Migration 075: Stage 1-3 preference lineage, authoritative freshness, and company policy evidence.
--
-- This migration is additive and replay-safe. It does not rewrite existing decisions,
-- ranking snapshots, job versions, or profile data. Preference values are neutral,
-- workspace/user-scoped data: no user preference payloads are seeded and no personal
-- values are supplied as database defaults.
--
-- Source timestamps on job_versions are deliberately nullable and have no defaults.
-- Existing observed_at/created_at columns remain ingestion/audit timestamps, not
-- substitutes for authoritative publication, update, expiry, or verification dates.
--
-- Reversal strategy: switch a preference's active pointer to an earlier immutable
-- revision (the activation event is retained); consumers can ignore the nullable
-- lineage columns and new observation tables. Do not drop the append-only history.

-- ============================================================================
-- 1) Authoritative job-version freshness facts (unknown remains NULL)
-- ============================================================================

-- This unique index supports workspace-safe foreign keys to immutable job versions.
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_versions_workspace_id_id
  ON job_versions (workspace_id, id);

ALTER TABLE job_versions
  ADD COLUMN IF NOT EXISTS source_published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_last_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reposted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS freshness_basis TEXT,
  ADD COLUMN IF NOT EXISTS freshness_confidence NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS job_age_days INTEGER,
  ADD COLUMN IF NOT EXISTS freshness_score NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS source_posting_identity_hash TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_versions'
      AND constraint_name = 'job_versions_source_posting_identity_hash_chk'
  ) THEN
    ALTER TABLE job_versions
      ADD CONSTRAINT job_versions_source_posting_identity_hash_chk
      CHECK (
        source_posting_identity_hash IS NULL
        OR BTRIM(source_posting_identity_hash) <> ''
      );
  END IF;
END;
$$;

-- Build the replacement identity key before removing the legacy constraint. If
-- existing data violates the new key, the migration fails without losing the old guard.
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_versions_workspace_canonical_posting_identity
  ON job_versions (
    workspace_id,
    canonical_job_id,
    (COALESCE(source_posting_identity_hash, content_hash))
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_versions'
      AND constraint_name = 'uq_canonical_job_content_hash'
      AND constraint_type = 'UNIQUE'
  ) THEN
    ALTER TABLE job_versions
      DROP CONSTRAINT uq_canonical_job_content_hash;
  END IF;
END;
$$;

COMMENT ON INDEX uq_job_versions_workspace_canonical_posting_identity IS
  'Deduplicates legacy versions by content hash when source identity is unknown, and verified postings by source identity so distinct postings may share identical content.';

-- Legacy sightings are only approximate local observation bounds, not posting dates.
-- Fill missing values once; never overwrite explicitly supplied sighting timestamps.
UPDATE job_versions
SET first_seen_at = observed_at
WHERE first_seen_at IS NULL AND observed_at IS NOT NULL;
UPDATE job_versions
SET last_seen_at = observed_at
WHERE last_seen_at IS NULL AND observed_at IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_versions'
      AND constraint_name = 'job_versions_freshness_basis_chk'
  ) THEN
    ALTER TABLE job_versions
      ADD CONSTRAINT job_versions_freshness_basis_chk
      CHECK (freshness_basis IS NULL OR BTRIM(freshness_basis) <> '');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_versions'
      AND constraint_name = 'job_versions_freshness_confidence_chk'
  ) THEN
    ALTER TABLE job_versions
      ADD CONSTRAINT job_versions_freshness_confidence_chk
      CHECK (freshness_confidence IS NULL OR freshness_confidence BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_versions'
      AND constraint_name = 'job_versions_job_age_days_chk'
  ) THEN
    ALTER TABLE job_versions
      ADD CONSTRAINT job_versions_job_age_days_chk
      CHECK (job_age_days IS NULL OR job_age_days >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_versions'
      AND constraint_name = 'job_versions_freshness_score_chk'
  ) THEN
    ALTER TABLE job_versions
      ADD CONSTRAINT job_versions_freshness_score_chk
      CHECK (freshness_score IS NULL OR freshness_score BETWEEN 0 AND 100);
  END IF;
END;
$$;

COMMENT ON COLUMN job_versions.source_published_at IS
  'Authoritative publication time supplied by the source; NULL when unavailable or unverified.';
COMMENT ON COLUMN job_versions.source_updated_at IS
  'Authoritative source-content modification time only; it must not reset posting age or substitute for source_published_at/reposted_at.';
COMMENT ON COLUMN job_versions.source_expires_at IS
  'Authoritative source expiry/closing time; NULL when unavailable or unverified.';
COMMENT ON COLUMN job_versions.source_last_verified_at IS
  'Time the source affirmatively confirmed this version was current; never inferred from ingestion time.';
COMMENT ON COLUMN job_versions.content_hash IS
  'Hash of version content only; source posting identity belongs in source_posting_identity_hash.';
COMMENT ON COLUMN job_versions.source_posting_identity_hash IS
  'Optional hash of an independently verified stable source posting identity; NULL preserves legacy content-hash deduplication and is never inferred from ingestion time.';
COMMENT ON COLUMN job_versions.reposted_at IS
  'Authoritative date the source confirms this posting was reposted; NULL when unavailable or unverified.';
COMMENT ON COLUMN job_versions.first_seen_at IS
  'Local first-seen observation time; legacy values may be backfilled from observed_at and this field is never an authoritative posting date.';
COMMENT ON COLUMN job_versions.last_seen_at IS
  'Local last-seen observation time; legacy values may be backfilled from observed_at and this field is not an authoritative source freshness date.';
COMMENT ON COLUMN job_versions.freshness_basis IS
  'Optional basis identifier for freshness calculations; NULL means no supported basis is recorded.';
COMMENT ON COLUMN job_versions.freshness_confidence IS
  'Optional freshness confidence from 0 to 100; NULL means unknown.';
COMMENT ON COLUMN job_versions.job_age_days IS
  'Optional age in days derived from an approved posting/repost date, never from source_updated_at or first_seen_at.';
COMMENT ON COLUMN job_versions.freshness_score IS
  'Optional freshness score from 0 to 100; NULL means no score is supported.';

CREATE INDEX IF NOT EXISTS idx_job_versions_workspace_published_at
  ON job_versions (workspace_id, source_published_at DESC)
  WHERE source_published_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_versions_workspace_expires_at
  ON job_versions (workspace_id, source_expires_at)
  WHERE source_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_versions_workspace_freshness_score
  ON job_versions (workspace_id, freshness_score DESC)
  WHERE freshness_score IS NOT NULL;

-- ============================================================================
-- 2) Generic immutable workspace/user preference revisions and active versions
-- ============================================================================

CREATE TABLE IF NOT EXISTS workspace_user_preference_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  preference_domain TEXT NOT NULL
    CHECK (preference_domain ~ '^[a-z][a-z0-9_]{0,62}$'),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  schema_version TEXT NOT NULL CHECK (BTRIM(schema_version) <> ''),
  preference_value JSONB NOT NULL
    CHECK (jsonb_typeof(preference_value) = 'object'),
  preference_hash TEXT NOT NULL CHECK (BTRIM(preference_hash) <> ''),
  created_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT workspace_user_preference_revisions_membership_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_user_preference_revisions_creator_fk
    FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_user_preference_revisions_version_key
    UNIQUE (workspace_id, user_id, preference_domain, revision_number),
  CONSTRAINT workspace_user_preference_revisions_id_scope_key
    UNIQUE (workspace_id, user_id, preference_domain, id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_user_preference_revisions_history
  ON workspace_user_preference_revisions
    (workspace_id, user_id, preference_domain, revision_number DESC);

CREATE TABLE IF NOT EXISTS workspace_user_preference_active_versions (
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  preference_domain TEXT NOT NULL
    CHECK (preference_domain ~ '^[a-z][a-z0-9_]{0,62}$'),
  revision_id UUID NOT NULL,
  activated_by_user_id UUID,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT workspace_user_preference_active_versions_pk
    PRIMARY KEY (workspace_id, user_id, preference_domain),
  CONSTRAINT workspace_user_preference_active_versions_membership_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_user_preference_active_versions_actor_fk
    FOREIGN KEY (workspace_id, activated_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_user_preference_active_versions_revision_fk
    FOREIGN KEY (workspace_id, user_id, preference_domain, revision_id)
    REFERENCES workspace_user_preference_revisions
      (workspace_id, user_id, preference_domain, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_workspace_user_preference_active_versions_revision
  ON workspace_user_preference_active_versions (revision_id);

CREATE TABLE IF NOT EXISTS workspace_user_preference_activation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  preference_domain TEXT NOT NULL
    CHECK (preference_domain ~ '^[a-z][a-z0-9_]{0,62}$'),
  previous_revision_id UUID,
  active_revision_id UUID,
  action TEXT NOT NULL CHECK (action IN ('ACTIVATE', 'SWITCH', 'DEACTIVATE')),
  activated_by_user_id UUID,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT workspace_user_preference_activation_events_membership_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_user_preference_activation_events_actor_fk
    FOREIGN KEY (workspace_id, activated_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_user_preference_activation_events_previous_fk
    FOREIGN KEY (workspace_id, user_id, preference_domain, previous_revision_id)
    REFERENCES workspace_user_preference_revisions
      (workspace_id, user_id, preference_domain, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_user_preference_activation_events_active_fk
    FOREIGN KEY (workspace_id, user_id, preference_domain, active_revision_id)
    REFERENCES workspace_user_preference_revisions
      (workspace_id, user_id, preference_domain, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_user_preference_activation_events_transition_chk CHECK (
    (action = 'ACTIVATE' AND previous_revision_id IS NULL AND active_revision_id IS NOT NULL)
    OR (action = 'SWITCH' AND previous_revision_id IS NOT NULL AND active_revision_id IS NOT NULL
        AND previous_revision_id <> active_revision_id)
    OR (action = 'DEACTIVATE' AND previous_revision_id IS NOT NULL AND active_revision_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_workspace_user_preference_activation_events_history
  ON workspace_user_preference_activation_events
    (workspace_id, user_id, preference_domain, activated_at DESC);

-- An immutable context pins all preference-domain revisions used for a decision.
-- Context rows and their revision links are inserted together by the application.
CREATE TABLE IF NOT EXISTS workspace_user_preference_contexts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  context_hash TEXT NOT NULL CHECK (BTRIM(context_hash) <> ''),
  created_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT workspace_user_preference_contexts_membership_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_user_preference_contexts_creator_fk
    FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_user_preference_contexts_hash_key
    UNIQUE (workspace_id, user_id, context_hash),
  CONSTRAINT workspace_user_preference_contexts_id_scope_key
    UNIQUE (workspace_id, user_id, id)
);

CREATE TABLE IF NOT EXISTS workspace_user_preference_context_revisions (
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  context_id UUID NOT NULL,
  preference_domain TEXT NOT NULL
    CHECK (preference_domain ~ '^[a-z][a-z0-9_]{0,62}$'),
  revision_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT workspace_user_preference_context_revisions_pk
    PRIMARY KEY (context_id, preference_domain),
  CONSTRAINT workspace_user_preference_context_revisions_context_fk
    FOREIGN KEY (workspace_id, user_id, context_id)
    REFERENCES workspace_user_preference_contexts (workspace_id, user_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_user_preference_context_revisions_revision_fk
    FOREIGN KEY (workspace_id, user_id, preference_domain, revision_id)
    REFERENCES workspace_user_preference_revisions
      (workspace_id, user_id, preference_domain, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_workspace_user_preference_context_revisions_revision
  ON workspace_user_preference_context_revisions (revision_id);

-- Activation pointers can move or be cleared, but each transition is durably audited.
CREATE OR REPLACE FUNCTION jdec_preference_activation_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.activated_at := clock_timestamp();
  ELSIF NEW.revision_id IS DISTINCT FROM OLD.revision_id THEN
    NEW.activated_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workspace_user_preference_activation_timestamp
  ON workspace_user_preference_active_versions;
CREATE TRIGGER trg_workspace_user_preference_activation_timestamp
BEFORE INSERT OR UPDATE ON workspace_user_preference_active_versions
FOR EACH ROW EXECUTE FUNCTION jdec_preference_activation_timestamp();

CREATE OR REPLACE FUNCTION jdec_audit_preference_activation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO workspace_user_preference_activation_events (
      workspace_id, user_id, preference_domain, previous_revision_id,
      active_revision_id, action, activated_by_user_id, activated_at
    ) VALUES (
      NEW.workspace_id, NEW.user_id, NEW.preference_domain, NULL,
      NEW.revision_id, 'ACTIVATE', NEW.activated_by_user_id, NEW.activated_at
    );
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.revision_id IS DISTINCT FROM OLD.revision_id THEN
      INSERT INTO workspace_user_preference_activation_events (
        workspace_id, user_id, preference_domain, previous_revision_id,
        active_revision_id, action, activated_by_user_id, activated_at
      ) VALUES (
        NEW.workspace_id, NEW.user_id, NEW.preference_domain, OLD.revision_id,
        NEW.revision_id, 'SWITCH', NEW.activated_by_user_id, NEW.activated_at
      );
    END IF;
    RETURN NEW;
  ELSE
    INSERT INTO workspace_user_preference_activation_events (
      workspace_id, user_id, preference_domain, previous_revision_id,
      active_revision_id, action, activated_by_user_id, activated_at
    ) VALUES (
      OLD.workspace_id, OLD.user_id, OLD.preference_domain, OLD.revision_id,
      NULL, 'DEACTIVATE', OLD.activated_by_user_id, clock_timestamp()
    );
    RETURN OLD;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_workspace_user_preference_activation_audit
  ON workspace_user_preference_active_versions;
CREATE TRIGGER trg_workspace_user_preference_activation_audit
AFTER INSERT OR UPDATE OR DELETE ON workspace_user_preference_active_versions
FOR EACH ROW EXECUTE FUNCTION jdec_audit_preference_activation();

-- ============================================================================
-- 3) Preference context lineage on immutable lane decisions, V5 decisions, and rankings
-- ============================================================================

ALTER TABLE gate_decisions
  ADD COLUMN IF NOT EXISTS preference_user_id UUID,
  ADD COLUMN IF NOT EXISTS preference_context_id UUID;

ALTER TABLE lane_decisions
  ADD COLUMN IF NOT EXISTS preference_user_id UUID,
  ADD COLUMN IF NOT EXISTS preference_context_id UUID;

ALTER TABLE deterministic_decisions
  ADD COLUMN IF NOT EXISTS preference_user_id UUID,
  ADD COLUMN IF NOT EXISTS preference_context_id UUID;

ALTER TABLE job_ranking_snapshots
  ADD COLUMN IF NOT EXISTS preference_user_id UUID,
  ADD COLUMN IF NOT EXISTS preference_context_id UUID,
  ADD COLUMN IF NOT EXISTS base_rank_score NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS freshness_score NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS remote_freedom_score NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS final_application_priority_score NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS remote_from_home_base_score NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS temporary_abroad_score NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS country_flexibility_score NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS office_requirement_score NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS timezone_compatibility_score NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS employment_verifiability_score NUMERIC(5,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'gate_decisions'
      AND constraint_name = 'gate_decisions_preference_context_pair_chk'
  ) THEN
    ALTER TABLE gate_decisions
      ADD CONSTRAINT gate_decisions_preference_context_pair_chk
      CHECK ((preference_user_id IS NULL) = (preference_context_id IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'gate_decisions'
      AND constraint_name = 'gate_decisions_preference_context_fk'
  ) THEN
    ALTER TABLE gate_decisions
      ADD CONSTRAINT gate_decisions_preference_context_fk
      FOREIGN KEY (workspace_id, preference_user_id, preference_context_id)
      REFERENCES workspace_user_preference_contexts (workspace_id, user_id, id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'lane_decisions'
      AND constraint_name = 'lane_decisions_preference_context_pair_chk'
  ) THEN
    ALTER TABLE lane_decisions
      ADD CONSTRAINT lane_decisions_preference_context_pair_chk
      CHECK ((preference_user_id IS NULL) = (preference_context_id IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'lane_decisions'
      AND constraint_name = 'lane_decisions_preference_context_fk'
  ) THEN
    ALTER TABLE lane_decisions
      ADD CONSTRAINT lane_decisions_preference_context_fk
      FOREIGN KEY (workspace_id, preference_user_id, preference_context_id)
      REFERENCES workspace_user_preference_contexts (workspace_id, user_id, id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'deterministic_decisions'
      AND constraint_name = 'deterministic_decisions_preference_context_pair_chk'
  ) THEN
    ALTER TABLE deterministic_decisions
      ADD CONSTRAINT deterministic_decisions_preference_context_pair_chk
      CHECK ((preference_user_id IS NULL) = (preference_context_id IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'deterministic_decisions'
      AND constraint_name = 'deterministic_decisions_preference_context_fk'
  ) THEN
    ALTER TABLE deterministic_decisions
      ADD CONSTRAINT deterministic_decisions_preference_context_fk
      FOREIGN KEY (workspace_id, preference_user_id, preference_context_id)
      REFERENCES workspace_user_preference_contexts (workspace_id, user_id, id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_ranking_snapshots'
      AND constraint_name = 'job_ranking_snapshots_preference_context_pair_chk'
  ) THEN
    ALTER TABLE job_ranking_snapshots
      ADD CONSTRAINT job_ranking_snapshots_preference_context_pair_chk
      CHECK ((preference_user_id IS NULL) = (preference_context_id IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_ranking_snapshots'
      AND constraint_name = 'job_ranking_snapshots_preference_context_fk'
  ) THEN
    ALTER TABLE job_ranking_snapshots
      ADD CONSTRAINT job_ranking_snapshots_preference_context_fk
      FOREIGN KEY (workspace_id, preference_user_id, preference_context_id)
      REFERENCES workspace_user_preference_contexts (workspace_id, user_id, id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_ranking_snapshots'
      AND constraint_name = 'job_ranking_snapshots_base_rank_score_chk'
  ) THEN
    ALTER TABLE job_ranking_snapshots
      ADD CONSTRAINT job_ranking_snapshots_base_rank_score_chk
      CHECK (base_rank_score IS NULL OR base_rank_score BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_ranking_snapshots'
      AND constraint_name = 'job_ranking_snapshots_freshness_score_chk'
  ) THEN
    ALTER TABLE job_ranking_snapshots
      ADD CONSTRAINT job_ranking_snapshots_freshness_score_chk
      CHECK (freshness_score IS NULL OR freshness_score BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_ranking_snapshots'
      AND constraint_name = 'job_ranking_snapshots_remote_freedom_score_chk'
  ) THEN
    ALTER TABLE job_ranking_snapshots
      ADD CONSTRAINT job_ranking_snapshots_remote_freedom_score_chk
      CHECK (remote_freedom_score IS NULL OR remote_freedom_score BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_ranking_snapshots'
      AND constraint_name = 'job_ranking_snapshots_final_application_priority_score_chk'
  ) THEN
    ALTER TABLE job_ranking_snapshots
      ADD CONSTRAINT job_ranking_snapshots_final_application_priority_score_chk
      CHECK (
        final_application_priority_score IS NULL
        OR final_application_priority_score BETWEEN 0 AND 100
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_ranking_snapshots'
      AND constraint_name = 'job_ranking_snapshots_remote_from_home_base_score_chk'
  ) THEN
    ALTER TABLE job_ranking_snapshots
      ADD CONSTRAINT job_ranking_snapshots_remote_from_home_base_score_chk
      CHECK (remote_from_home_base_score IS NULL OR remote_from_home_base_score BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_ranking_snapshots'
      AND constraint_name = 'job_ranking_snapshots_temporary_abroad_score_chk'
  ) THEN
    ALTER TABLE job_ranking_snapshots
      ADD CONSTRAINT job_ranking_snapshots_temporary_abroad_score_chk
      CHECK (temporary_abroad_score IS NULL OR temporary_abroad_score BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_ranking_snapshots'
      AND constraint_name = 'job_ranking_snapshots_country_flexibility_score_chk'
  ) THEN
    ALTER TABLE job_ranking_snapshots
      ADD CONSTRAINT job_ranking_snapshots_country_flexibility_score_chk
      CHECK (country_flexibility_score IS NULL OR country_flexibility_score BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_ranking_snapshots'
      AND constraint_name = 'job_ranking_snapshots_office_requirement_score_chk'
  ) THEN
    ALTER TABLE job_ranking_snapshots
      ADD CONSTRAINT job_ranking_snapshots_office_requirement_score_chk
      CHECK (office_requirement_score IS NULL OR office_requirement_score BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_ranking_snapshots'
      AND constraint_name = 'job_ranking_snapshots_timezone_compatibility_score_chk'
  ) THEN
    ALTER TABLE job_ranking_snapshots
      ADD CONSTRAINT job_ranking_snapshots_timezone_compatibility_score_chk
      CHECK (timezone_compatibility_score IS NULL OR timezone_compatibility_score BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'job_ranking_snapshots'
      AND constraint_name = 'job_ranking_snapshots_employment_verifiability_score_chk'
  ) THEN
    ALTER TABLE job_ranking_snapshots
      ADD CONSTRAINT job_ranking_snapshots_employment_verifiability_score_chk
      CHECK (employment_verifiability_score IS NULL OR employment_verifiability_score BETWEEN 0 AND 100);
  END IF;
END;
$$;

-- Keep the former uniqueness semantics for historical rows whose preference
-- context is NULL, while allowing otherwise-identical snapshots from distinct contexts.
DO $$
DECLARE
  context_key_definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(constraint_row.oid)
  INTO context_key_definition
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'job_ranking_snapshots'::regclass
    AND constraint_row.conname = 'job_ranking_snapshots_context_key'
    AND constraint_row.contype = 'u';

  IF context_key_definition IS NULL
     OR POSITION('preference_context_id' IN context_key_definition) = 0
     OR POSITION('NULLS NOT DISTINCT' IN UPPER(context_key_definition)) = 0 THEN
    IF context_key_definition IS NOT NULL THEN
      ALTER TABLE job_ranking_snapshots
        DROP CONSTRAINT job_ranking_snapshots_context_key;
    END IF;

    ALTER TABLE job_ranking_snapshots
      ADD CONSTRAINT job_ranking_snapshots_context_key
      UNIQUE NULLS NOT DISTINCT (
        workspace_id,
        canonical_job_id,
        job_version_id,
        profile_version_id,
        match_run_id,
        deterministic_decision_id,
        ai_evaluation_id,
        ranking_policy_version,
        preference_context_id,
        context_fingerprint
      );
  END IF;
END;
$$;

COMMENT ON COLUMN job_ranking_snapshots.base_rank_score IS
  'Nullable base ranking score from 0 to 100, before independent freshness, remote-freedom, and final-priority components.';
COMMENT ON COLUMN job_ranking_snapshots.freshness_score IS
  'Nullable persisted freshness component score from 0 to 100; NULL means unavailable.';
COMMENT ON COLUMN job_ranking_snapshots.remote_freedom_score IS
  'Nullable persisted remote-work/geographic-freedom score from 0 to 100; NULL means unavailable.';
COMMENT ON COLUMN job_ranking_snapshots.final_application_priority_score IS
  'Nullable final application-priority score from 0 to 100; this score does not itself change a gate or recommendation outcome.';
COMMENT ON COLUMN job_ranking_snapshots.remote_from_home_base_score IS
  'Nullable generic score from 0 to 100 for remote-work feasibility from the relevant home base; NULL means unavailable.';
COMMENT ON COLUMN job_ranking_snapshots.temporary_abroad_score IS
  'Nullable generic score from 0 to 100 for temporary work-abroad feasibility; NULL means unavailable.';
COMMENT ON COLUMN job_ranking_snapshots.country_flexibility_score IS
  'Nullable generic score from 0 to 100 for country/location flexibility; NULL means unavailable.';
COMMENT ON COLUMN job_ranking_snapshots.office_requirement_score IS
  'Nullable generic score from 0 to 100 for compatibility with office-attendance requirements; NULL means unavailable.';
COMMENT ON COLUMN job_ranking_snapshots.timezone_compatibility_score IS
  'Nullable generic score from 0 to 100 for compatibility with required working time zones; NULL means unavailable.';
COMMENT ON COLUMN job_ranking_snapshots.employment_verifiability_score IS
  'Nullable generic score from 0 to 100 for verifiability of employment terms; NULL means unavailable.';
COMMENT ON CONSTRAINT job_ranking_snapshots_context_key ON job_ranking_snapshots IS
  'Ranks are unique by full decision context and pinned preference_context_id; NULLS NOT DISTINCT preserves legacy uniqueness for historical rows without preference lineage.';

CREATE INDEX IF NOT EXISTS idx_gate_decisions_preference_context
  ON gate_decisions (workspace_id, preference_context_id)
  WHERE preference_context_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lane_decisions_preference_context
  ON lane_decisions (workspace_id, preference_context_id)
  WHERE preference_context_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deterministic_decisions_preference_context
  ON deterministic_decisions (workspace_id, preference_context_id)
  WHERE preference_context_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_ranking_snapshots_preference_context
  ON job_ranking_snapshots (workspace_id, preference_context_id)
  WHERE preference_context_id IS NOT NULL;

COMMENT ON COLUMN gate_decisions.preference_context_id IS
  'Immutable user-preference context used by this gate decision; NULL for historical decisions without captured lineage.';
COMMENT ON COLUMN lane_decisions.preference_context_id IS
  'Immutable user-preference context used by this lane decision; NULL for historical decisions without captured lineage.';
COMMENT ON COLUMN deterministic_decisions.preference_context_id IS
  'Immutable user-preference context used by this decision; NULL for historical decisions without captured lineage.';
COMMENT ON COLUMN job_ranking_snapshots.preference_context_id IS
  'Immutable user-preference context used by this ranking; NULL for historical rankings without captured lineage.';

-- ============================================================================
-- 4) Append-only, versioned company policy observations with provenance
-- ============================================================================

CREATE TABLE IF NOT EXISTS workspace_company_policy_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  workspace_company_id UUID NOT NULL,
  policy_domain TEXT NOT NULL
    CHECK (policy_domain ~ '^[a-z][a-z0-9_]{0,62}$'),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  supersedes_revision_number INTEGER,
  supersedes_observation_id UUID,
  schema_version TEXT NOT NULL CHECK (BTRIM(schema_version) <> ''),
  policy_value JSONB NOT NULL
    CHECK (jsonb_typeof(policy_value) <> 'null' AND policy_value <> '{}'::JSONB),
  confidence NUMERIC(5,2),
  source_type TEXT NOT NULL
    CHECK (source_type IN ('JOB_VERSION', 'COMPANY_SOURCE', 'USER_REPORTED', 'OTHER')),
  source_url TEXT CHECK (source_url IS NULL OR BTRIM(source_url) <> ''),
  source_job_version_id UUID,
  source_content_hash TEXT
    CHECK (source_content_hash IS NULL OR BTRIM(source_content_hash) <> ''),
  source_published_at TIMESTAMPTZ,
  evidence JSONB NOT NULL
    CHECK (jsonb_typeof(evidence) = 'object' AND evidence <> '{}'::JSONB),
  created_by_user_id UUID,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT workspace_company_policy_observations_company_fk
    FOREIGN KEY (workspace_id, workspace_company_id)
    REFERENCES workspace_companies (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_company_policy_observations_job_version_fk
    FOREIGN KEY (workspace_id, source_job_version_id)
    REFERENCES job_versions (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_company_policy_observations_creator_fk
    FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_company_policy_observations_version_key
    UNIQUE (workspace_id, workspace_company_id, policy_domain, revision_number),
  CONSTRAINT workspace_company_policy_observations_id_scope_key
    UNIQUE (workspace_id, workspace_company_id, policy_domain, revision_number, id),
  CONSTRAINT workspace_company_policy_observations_single_successor_key
    UNIQUE (workspace_id, workspace_company_id, policy_domain, supersedes_observation_id),
  CONSTRAINT workspace_company_policy_observations_supersedes_fk
    FOREIGN KEY (
      workspace_id, workspace_company_id, policy_domain,
      supersedes_revision_number, supersedes_observation_id
    ) REFERENCES workspace_company_policy_observations (
      workspace_id, workspace_company_id, policy_domain, revision_number, id
    ) ON DELETE RESTRICT,
  CONSTRAINT workspace_company_policy_observations_revision_chain_chk CHECK (
    (revision_number = 1 AND supersedes_revision_number IS NULL AND supersedes_observation_id IS NULL)
    OR (revision_number > 1
        AND supersedes_revision_number = revision_number - 1
        AND supersedes_observation_id IS NOT NULL)
  ),
  CONSTRAINT workspace_company_policy_observations_provenance_chk CHECK (
    (source_type = 'JOB_VERSION' AND source_job_version_id IS NOT NULL)
    OR (source_type = 'COMPANY_SOURCE' AND source_url IS NOT NULL)
    OR (source_type = 'USER_REPORTED' AND created_by_user_id IS NOT NULL)
    OR (source_type = 'OTHER' AND (
      source_url IS NOT NULL OR source_job_version_id IS NOT NULL
      OR source_content_hash IS NOT NULL OR created_by_user_id IS NOT NULL
    ))
  )
);

-- Also covers a replay against a database where the earlier 075 definition exists.
ALTER TABLE workspace_company_policy_observations
  ADD COLUMN IF NOT EXISTS confidence NUMERIC(5,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'workspace_company_policy_observations'
      AND constraint_name = 'workspace_company_policy_observations_confidence_chk'
  ) THEN
    ALTER TABLE workspace_company_policy_observations
      ADD CONSTRAINT workspace_company_policy_observations_confidence_chk
      CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100);
  END IF;
END;
$$;

COMMENT ON COLUMN workspace_company_policy_observations.confidence IS
  'Optional observation confidence from 0 to 100; NULL means unknown.';

CREATE INDEX IF NOT EXISTS idx_workspace_company_policy_observations_domain_history
  ON workspace_company_policy_observations
    (workspace_id, workspace_company_id, policy_domain, revision_number DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_company_policy_observations_job_version
  ON workspace_company_policy_observations (workspace_id, source_job_version_id)
  WHERE source_job_version_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_company_policy_observations_source_published
  ON workspace_company_policy_observations (workspace_id, source_published_at DESC)
  WHERE source_published_at IS NOT NULL;

-- A shared guard prevents updates/deletes to revision, context, and observation history.
CREATE OR REPLACE FUNCTION jdec_append_only_row_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only; insert a new revision or observation instead.', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_workspace_user_preference_revisions_append_only
  ON workspace_user_preference_revisions;
CREATE TRIGGER trg_workspace_user_preference_revisions_append_only
BEFORE UPDATE OR DELETE ON workspace_user_preference_revisions
FOR EACH ROW EXECUTE FUNCTION jdec_append_only_row_guard();

DROP TRIGGER IF EXISTS trg_workspace_user_preference_activation_events_append_only
  ON workspace_user_preference_activation_events;
CREATE TRIGGER trg_workspace_user_preference_activation_events_append_only
BEFORE UPDATE OR DELETE ON workspace_user_preference_activation_events
FOR EACH ROW EXECUTE FUNCTION jdec_append_only_row_guard();

DROP TRIGGER IF EXISTS trg_workspace_user_preference_contexts_append_only
  ON workspace_user_preference_contexts;
CREATE TRIGGER trg_workspace_user_preference_contexts_append_only
BEFORE UPDATE OR DELETE ON workspace_user_preference_contexts
FOR EACH ROW EXECUTE FUNCTION jdec_append_only_row_guard();

DROP TRIGGER IF EXISTS trg_workspace_user_preference_context_revisions_append_only
  ON workspace_user_preference_context_revisions;
CREATE TRIGGER trg_workspace_user_preference_context_revisions_append_only
BEFORE UPDATE OR DELETE ON workspace_user_preference_context_revisions
FOR EACH ROW EXECUTE FUNCTION jdec_append_only_row_guard();

DROP TRIGGER IF EXISTS trg_workspace_company_policy_observations_append_only
  ON workspace_company_policy_observations;
CREATE TRIGGER trg_workspace_company_policy_observations_append_only
BEFORE UPDATE OR DELETE ON workspace_company_policy_observations
FOR EACH ROW EXECUTE FUNCTION jdec_append_only_row_guard();

COMMENT ON TABLE workspace_user_preference_revisions IS
  'Generic immutable per-user preference revisions, including lane intent and future policy domains; contains no global personal defaults.';
COMMENT ON TABLE workspace_user_preference_active_versions IS
  'Current preference revision pointer per workspace user and domain; every pointer transition is appended to activation events.';
COMMENT ON TABLE workspace_user_preference_contexts IS
  'Immutable hash-addressed capture of a user preference revision set for decision and ranking lineage.';
COMMENT ON TABLE workspace_user_preference_context_revisions IS
  'Revision members pinned by a preference context, one immutable revision per preference domain.';
COMMENT ON TABLE workspace_company_policy_observations IS
  'Append-only, workspace-scoped company policy observations with explicit version chain and source provenance.';

-- Stable scoped read models expose Stage 3 score components without making the
-- Streamlit consumer join operational tables or infer snapshot relationships.
CREATE OR REPLACE VIEW v_apply_now_jobs_stage3_scoped AS
SELECT
  apply_now.*,
  ranking.base_rank_score,
  ranking.freshness_score,
  ranking.remote_freedom_score,
  ranking.final_application_priority_score,
  ranking.remote_from_home_base_score,
  ranking.temporary_abroad_score,
  ranking.country_flexibility_score,
  ranking.office_requirement_score,
  ranking.timezone_compatibility_score,
  ranking.employment_verifiability_score,
  ranking.preference_context_id AS stage3_preference_context_id,
  ranking.component_availability AS ranking_component_availability,
  ranking.component_provenance AS ranking_component_provenance
FROM v_apply_now_jobs_scoped AS apply_now
LEFT JOIN job_ranking_snapshots AS ranking
  ON ranking.id = apply_now.ranking_snapshot_id
 AND ranking.workspace_id = apply_now.workspace_id
 AND ranking.canonical_job_id = apply_now.canonical_job_id
 AND ranking.job_version_id = apply_now.job_version_id::UUID;

CREATE OR REPLACE VIEW v_top_ten_ready_jobs_stage3_scoped AS
SELECT
  top_ten.*,
  ranking.base_rank_score,
  ranking.freshness_score,
  ranking.remote_freedom_score,
  ranking.final_application_priority_score,
  ranking.remote_from_home_base_score,
  ranking.temporary_abroad_score,
  ranking.country_flexibility_score,
  ranking.office_requirement_score,
  ranking.timezone_compatibility_score,
  ranking.employment_verifiability_score,
  ranking.preference_context_id AS stage3_preference_context_id,
  ranking.component_availability AS ranking_component_availability,
  ranking.component_provenance AS ranking_component_provenance
FROM v_top_ten_ready_jobs_scoped AS top_ten
JOIN job_ranking_snapshots AS ranking
  ON ranking.id = top_ten.ranking_snapshot_id
 AND ranking.workspace_id = top_ten.workspace_id
 AND ranking.canonical_job_id = top_ten.canonical_job_id
 AND ranking.job_version_id = top_ten.job_version_id::UUID;

COMMENT ON VIEW v_apply_now_jobs_stage3_scoped IS
  'Apply Now rows with the matching current Stage 3 ranking snapshot components and preference lineage.';
COMMENT ON VIEW v_top_ten_ready_jobs_stage3_scoped IS
  'Top 10 rows with explicit Stage 3 ranking components and preference lineage from the exact snapshot.';
