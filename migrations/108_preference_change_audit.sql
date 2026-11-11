-- Migration 108: workspace_user_preference_change_audit records every operator-approved change of an
-- active preference revision made by scripts/activate_workspace_preferences.ts.
--
-- workspace_user_preference_activation_events (migration 075) already records each pointer move, but
-- not who approved it, why, or which reviewed diff it applied. This table adds that, one row per
-- preference domain per apply or rollback, written in the same transaction as the activation. It holds
-- revision ids, preference hashes, the reviewed diff hash, the operator, the reason and the names of
-- changed fields; never preference values. Rows are append-only: UPDATE and DELETE are rejected.
--
-- Additive only. Rollback (human approval required, because it removes audit history):
--   DROP TABLE workspace_user_preference_change_audit;
--   DROP FUNCTION jdec_reject_preference_change_audit_mutation();

CREATE TABLE IF NOT EXISTS workspace_user_preference_change_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  preference_domain TEXT NOT NULL
    CHECK (preference_domain ~ '^[a-z][a-z0-9_]{0,62}$'),
  action TEXT NOT NULL CHECK (action IN ('APPLY', 'ROLLBACK')),
  previous_revision_id UUID,
  active_revision_id UUID NOT NULL,
  previous_preference_hash TEXT,
  active_preference_hash TEXT NOT NULL CHECK (BTRIM(active_preference_hash) <> ''),
  activation_event_id UUID REFERENCES workspace_user_preference_activation_events (id) ON DELETE RESTRICT,
  diff_hash TEXT NOT NULL CHECK (diff_hash ~ '^[0-9a-f]{64}$'),
  operator TEXT NOT NULL CHECK (BTRIM(operator) <> '' AND char_length(operator) <= 120),
  reason TEXT NOT NULL CHECK (BTRIM(reason) <> '' AND char_length(reason) <= 1000),
  changed_paths JSONB NOT NULL CHECK (jsonb_typeof(changed_paths) = 'array'),
  tool TEXT NOT NULL CHECK (BTRIM(tool) <> ''),
  database_role TEXT NOT NULL DEFAULT current_user,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT workspace_user_preference_change_audit_membership_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_user_preference_change_audit_previous_fk
    FOREIGN KEY (workspace_id, user_id, preference_domain, previous_revision_id)
    REFERENCES workspace_user_preference_revisions
      (workspace_id, user_id, preference_domain, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_user_preference_change_audit_active_fk
    FOREIGN KEY (workspace_id, user_id, preference_domain, active_revision_id)
    REFERENCES workspace_user_preference_revisions
      (workspace_id, user_id, preference_domain, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_user_preference_change_audit_transition_chk
    CHECK (previous_revision_id IS NULL OR previous_revision_id <> active_revision_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_user_preference_change_audit_history
  ON workspace_user_preference_change_audit
    (workspace_id, user_id, preference_domain, recorded_at DESC);

CREATE OR REPLACE FUNCTION jdec_reject_preference_change_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'workspace_user_preference_change_audit is append-only (% rejected)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_workspace_user_preference_change_audit_append_only
  ON workspace_user_preference_change_audit;
CREATE TRIGGER trg_workspace_user_preference_change_audit_append_only
BEFORE UPDATE OR DELETE ON workspace_user_preference_change_audit
FOR EACH ROW EXECUTE FUNCTION jdec_reject_preference_change_audit_mutation();
