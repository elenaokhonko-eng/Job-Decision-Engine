-- Migration 004: Queue Backoff, Gmail UID, Gate Evidence Storage
-- Additive only — no DROP, no TRUNCATE, reversible via 004_rollback.sql

-- 1. Exponential backoff for RETRY_WAIT items in the evaluation queue
ALTER TABLE evaluation_queue
  ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ DEFAULT NOW();

-- Back-fill existing RETRY_WAIT rows so they are eligible immediately
UPDATE evaluation_queue SET available_at = NOW() WHERE status = 'RETRY_WAIT' AND available_at IS NULL;

-- Index for efficient polling of eligible items
CREATE INDEX IF NOT EXISTS idx_eval_queue_eligible
  ON evaluation_queue (status, available_at, priority_score DESC)
  WHERE status IN ('PENDING', 'RETRY_WAIT');

-- 2. Gmail message UID and audit columns on raw_email_alerts (prevents re-fetch of already-processed messages)
ALTER TABLE raw_email_alerts
  ADD COLUMN IF NOT EXISTS gmail_message_id TEXT,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_email_alerts_gmail_uid
  ON raw_email_alerts (gmail_message_id)
  WHERE gmail_message_id IS NOT NULL;

-- 3. Structured gate evidence on canonical_jobs
ALTER TABLE canonical_jobs
  ADD COLUMN IF NOT EXISTS gate_evidence_quotes JSONB,
  ADD COLUMN IF NOT EXISTS workability_facts     JSONB;

-- 4. Immutable gate audit log (invariant 6: every gate decision is recorded)
CREATE TABLE IF NOT EXISTS gate_decisions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_job_id  UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
  job_version_id    UUID,
  gate_version      TEXT NOT NULL DEFAULT '2.0',
  decision          TEXT NOT NULL CHECK (decision IN ('PASS', 'NEEDS_VERIFICATION', 'HARD_REJECT')),
  rejection_codes   JSONB NOT NULL DEFAULT '[]',
  evidence_quotes   JSONB NOT NULL DEFAULT '[]',
  workability_facts JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gate_decisions_job
  ON gate_decisions (canonical_job_id, created_at DESC);
