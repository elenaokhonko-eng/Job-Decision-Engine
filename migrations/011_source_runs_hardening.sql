-- Migration 011: Source runs legacy-shape hardening
-- Ensures source_runs always has the audit columns required by SourceBroker.

ALTER TABLE source_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE source_runs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE source_runs ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'RUNNING';
ALTER TABLE source_runs ADD COLUMN IF NOT EXISTS total_fetched INT DEFAULT 0;
ALTER TABLE source_runs ADD COLUMN IF NOT EXISTS total_new INT DEFAULT 0;
ALTER TABLE source_runs ADD COLUMN IF NOT EXISTS total_duplicates INT DEFAULT 0;
ALTER TABLE source_runs ADD COLUMN IF NOT EXISTS total_errors INT DEFAULT 0;
ALTER TABLE source_runs ADD COLUMN IF NOT EXISTS error_log JSONB DEFAULT '[]'::jsonb;
