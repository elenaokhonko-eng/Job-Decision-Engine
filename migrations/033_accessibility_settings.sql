-- Migration 033: Accessibility and neuroinclusive UX settings (workspace/user scoped)
--
-- Goals (P13):
-- 1) Persist per-user UI settings (quiet mode, density, contrast, font scale).
-- 2) Support predictable, resumable UI states without inferring diagnosis or disability.
--
-- Notes:
-- - Additive and reversible.
-- - Settings are optional; defaults should be safe and non-medicalized.

BEGIN;

CREATE TABLE IF NOT EXISTS workspace_user_accessibility_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES workspace_users(id) ON DELETE CASCADE,

  quiet_mode BOOLEAN NOT NULL DEFAULT FALSE,
  reduced_motion BOOLEAN NOT NULL DEFAULT FALSE,
  high_contrast BOOLEAN NOT NULL DEFAULT FALSE,
  density TEXT NOT NULL DEFAULT 'comfortable' CHECK (density IN ('comfortable', 'compact')),
  font_scale NUMERIC(3, 2) NOT NULL DEFAULT 1.00 CHECK (font_scale >= 0.80 AND font_scale <= 1.50),
  show_emojis BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_user_accessibility_settings_lookup
  ON workspace_user_accessibility_settings(workspace_id, user_id, updated_at DESC);

COMMIT;

