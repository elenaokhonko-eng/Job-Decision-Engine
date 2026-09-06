-- Migration 034: Preference modes and consent controls (workspace/user scoped)
--
-- Goals (P13):
-- 1) Allow multiple user-owned preference "modes" (e.g., quiet-focus vs high-energy days).
-- 2) Provide explicit consent toggles for optional AI/document features.
--
-- Notes:
-- - Additive and reversible.
-- - Modes store JSONB content validated by runtime (do not infer medical status).

BEGIN;

CREATE TABLE IF NOT EXISTS workspace_user_preference_modes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES workspace_users(id) ON DELETE CASCADE,

  mode_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,

  is_active BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (workspace_id, user_id, mode_key)
);

-- At most one active mode per user/workspace.
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_user_preference_modes_one_active
  ON workspace_user_preference_modes(workspace_id, user_id)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_workspace_user_preference_modes_lookup
  ON workspace_user_preference_modes(workspace_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_user_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES workspace_users(id) ON DELETE CASCADE,

  consent_key TEXT NOT NULL,
  granted BOOLEAN NOT NULL DEFAULT FALSE,
  granted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (workspace_id, user_id, consent_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_user_consents_lookup
  ON workspace_user_consents(workspace_id, user_id, updated_at DESC);

COMMIT;

