-- Migration 022: Conversational profile updates (sessions, proposals, clarifications, approvals)
--
-- Goals (IDE Closeout Pack P3):
-- 1) Persist profile update sessions against a base profile version (optimistic concurrency).
-- 2) Store extraction attempts and proposed operations (add/revise/retire/link).
-- 3) Capture clarifications and user approvals with idempotent duplicate-approval semantics.
-- 4) Record unknown taxonomy keys as candidates (never silently approved).
--
-- Notes:
-- - Additive and reversible (no drops of user data).
-- - Runtime should treat session application as transactional and idempotent.

BEGIN;

-- ============================================================================
-- 1) Profile update sessions
-- ============================================================================

CREATE TABLE IF NOT EXISTS profile_update_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  candidate_profile_id UUID NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
  base_profile_version_id UUID NOT NULL REFERENCES profile_versions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (
    status IN ('OPEN', 'NEEDS_CLARIFICATION', 'APPROVED', 'APPLIED', 'CONFLICT', 'CANCELLED')
  ),
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_profile_version_id UUID REFERENCES profile_versions(id) ON DELETE SET NULL,
  applied_at TIMESTAMPTZ,
  conflict_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_profile_update_sessions_workspace_created
  ON profile_update_sessions(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_update_sessions_profile
  ON profile_update_sessions(candidate_profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_update_sessions_status
  ON profile_update_sessions(workspace_id, status);

-- ============================================================================
-- 2) Extraction attempts (LLM runs are optional but attempts must be auditable)
-- ============================================================================

CREATE TABLE IF NOT EXISTS profile_update_extraction_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES profile_update_sessions(id) ON DELETE CASCADE,
  provider TEXT,
  model TEXT,
  prompt_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILED')),
  error_message TEXT,
  raw_prompt TEXT,
  raw_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profile_update_extraction_attempts_session
  ON profile_update_extraction_attempts(session_id, created_at DESC);

-- ============================================================================
-- 3) Proposed operations (insert-only proposals scoped to a session)
-- ============================================================================

CREATE TABLE IF NOT EXISTS profile_update_proposed_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES profile_update_sessions(id) ON DELETE CASCADE,
  extraction_attempt_id UUID REFERENCES profile_update_extraction_attempts(id) ON DELETE SET NULL,
  operation_type TEXT NOT NULL CHECK (
    operation_type IN ('ADD_FACT', 'REVISE_FACT', 'RETIRE_FACT', 'LINK_FACT')
  ),
  -- A deterministic key for idempotent proposal insertions within the session.
  operation_key TEXT NOT NULL,
  -- For non-add operations, the fact_key being targeted.
  target_fact_key TEXT,
  -- Operation payload; validated by runtime before application.
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, operation_key)
);

CREATE INDEX IF NOT EXISTS idx_profile_update_proposed_operations_session
  ON profile_update_proposed_operations(session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_profile_update_proposed_operations_target
  ON profile_update_proposed_operations(session_id, target_fact_key);

-- ============================================================================
-- 4) Clarifications (questions/answers linked to a session and optionally an operation)
-- ============================================================================

CREATE TABLE IF NOT EXISTS profile_update_clarifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES profile_update_sessions(id) ON DELETE CASCADE,
  operation_id UUID REFERENCES profile_update_proposed_operations(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ANSWERED', 'DISMISSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_profile_update_clarifications_session
  ON profile_update_clarifications(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_update_clarifications_status
  ON profile_update_clarifications(session_id, status);

-- ============================================================================
-- 5) Approvals (idempotent: each operation can be decided once)
-- ============================================================================

CREATE TABLE IF NOT EXISTS profile_update_operation_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES profile_update_sessions(id) ON DELETE CASCADE,
  operation_id UUID NOT NULL REFERENCES profile_update_proposed_operations(id) ON DELETE CASCADE,
  approved_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  decision TEXT NOT NULL DEFAULT 'APPROVED' CHECK (decision IN ('APPROVED', 'REJECTED')),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (operation_id)
);

CREATE INDEX IF NOT EXISTS idx_profile_update_operation_approvals_session
  ON profile_update_operation_approvals(session_id, approved_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_update_operation_approvals_decision
  ON profile_update_operation_approvals(session_id, decision);

-- ============================================================================
-- 6) Unknown taxonomy candidates (never silently approved)
-- ============================================================================

CREATE TABLE IF NOT EXISTS taxonomy_concept_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  proposed_key TEXT NOT NULL,
  proposed_payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  created_by_user_id UUID REFERENCES workspace_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, proposed_key)
);

CREATE INDEX IF NOT EXISTS idx_taxonomy_concept_candidates_workspace
  ON taxonomy_concept_candidates(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_taxonomy_concept_candidates_status
  ON taxonomy_concept_candidates(workspace_id, status);

COMMIT;

