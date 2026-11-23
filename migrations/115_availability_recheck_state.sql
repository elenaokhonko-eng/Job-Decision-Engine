-- Migration 115: durable state and audit trail for the RECHECK_AVAILABILITY task (workstream W1).
--
-- When a job's 7-day availability window runs out, one posting read re-evaluates whether the posting
-- is open, its work mode and its hiring territory. Two facts must survive between reads and must be
-- auditable, so they get their own tables instead of being squeezed into job_versions:
--
--   * job_availability_recheck_state: one row per canonical job. consecutive_absent_reads counts
--     SUCCESSFUL source-feed reads that did not contain the posting, in a row. A failed read never
--     changes it. cannot_tell_attempts counts reads that could not tell (timeout, 5xx, rate limit,
--     paywall, login, incomplete feed). cycle_started_at is when the current re-check cycle began
--     (the end of the expired window); it anchors the day-10 limit.
--   * job_availability_recheck_events: append-only. One row per read with its outcome, decision and the
--     counters after the read, so every closure, archive or reopening can be explained.
--
-- A posting is closed only on clear evidence (the page says not found or no longer accepting, or the
-- feed was read successfully and the posting was absent twice in a row). "Cannot tell" is retried and
-- then archived as POSTING_NOT_CONFIRMABLE through the existing archive service; nothing is deleted.
--
-- Additive only: two new tables and indexes. No existing table, view or constraint changes.
--
-- Rollback (nothing else depends on these tables):
--   DROP TABLE IF EXISTS job_availability_recheck_events;
--   DROP TABLE IF EXISTS job_availability_recheck_state;

CREATE TABLE IF NOT EXISTS job_availability_recheck_state (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE RESTRICT,
  job_version_id UUID,
  consecutive_absent_reads INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_absent_reads >= 0),
  cannot_tell_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cannot_tell_attempts >= 0),
  cycle_started_at TIMESTAMPTZ,
  last_read_at TIMESTAMPTZ,
  last_feed_read_at TIMESTAMPTZ,
  last_outcome TEXT,
  last_decision TEXT,
  next_check_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, canonical_job_id)
);

CREATE TABLE IF NOT EXISTS job_availability_recheck_events (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE RESTRICT,
  job_version_id UUID,
  task_id UUID,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_kind TEXT NOT NULL CHECK (read_kind IN ('FEED', 'PAGE', 'NONE')),
  outcome TEXT NOT NULL CHECK (outcome IN ('OPEN', 'CLOSED_BY_PAGE', 'FEED_ABSENT', 'CANNOT_TELL')),
  decision TEXT NOT NULL CHECK (decision IN (
    'MARK_OPEN', 'MARK_CLOSED', 'WAIT_NEXT_READ', 'RETRY_LATER', 'ARCHIVE_NOT_CONFIRMABLE', 'KEPT_PROTECTED'
  )),
  reason_code TEXT NOT NULL,
  consecutive_absent_reads_after INTEGER NOT NULL,
  cannot_tell_attempts_after INTEGER NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_job_availability_recheck_events_job
  ON job_availability_recheck_events (workspace_id, canonical_job_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_job_availability_recheck_state_due
  ON job_availability_recheck_state (workspace_id, next_check_at)
  WHERE next_check_at IS NOT NULL;

COMMENT ON TABLE job_availability_recheck_state IS
  'Per-job counters for RECHECK_AVAILABILITY: consecutive successful feed reads without the posting, and reads that could not tell.';
COMMENT ON TABLE job_availability_recheck_events IS
  'Append-only audit of every availability re-check read: outcome, decision and counters after the read.';
