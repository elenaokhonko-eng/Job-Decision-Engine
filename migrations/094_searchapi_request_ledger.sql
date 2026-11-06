-- Migration 094: SearchAPI request ledger and daily credit cap.
--
-- Every SearchAPI call (LinkedIn job search or job details) reserves one credit before the
-- request is sent. The reservation is a single atomic statement against the per-day counter,
-- so concurrent workers cannot overspend the configured daily cap. Each reservation leaves an
-- audit row with the engine, purpose, non-secret request key, and outcome. API keys are never
-- stored.
-- Rollback: stop the SearchAPI source and content-fetch paths (unset SEARCHAPI_API_KEY or
-- SEARCHAPI_LINKEDIN_ENABLED). Keep both tables; they are request history, not job data.

CREATE TABLE IF NOT EXISTS searchapi_credit_days (
  usage_day DATE PRIMARY KEY,
  credits_used INTEGER NOT NULL DEFAULT 0 CHECK (credits_used >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS searchapi_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usage_day DATE NOT NULL REFERENCES searchapi_credit_days (usage_day) ON DELETE RESTRICT,
  engine TEXT NOT NULL CHECK (engine IN ('linkedin_jobs', 'linkedin_job_details')),
  purpose TEXT NOT NULL CHECK (purpose IN ('DISCOVERY', 'CONTENT_FETCH')),
  request_key TEXT NOT NULL CHECK (BTRIM(request_key) <> '' AND LENGTH(request_key) <= 800),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('SUCCEEDED', 'FAILED')),
  error_detail TEXT CHECK (error_detail IS NULL OR LENGTH(error_detail) <= 1000),
  CHECK ((outcome IS NULL) = (completed_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_searchapi_requests_usage_day
  ON searchapi_requests (usage_day, engine, purpose);

-- LinkedIn postings read through SearchAPI can back a manual-flow fetch receipt. Widening the
-- provider check is additive; existing rows are unaffected.
ALTER TABLE manual_application_fetch_receipts
  DROP CONSTRAINT IF EXISTS manual_application_fetch_receipts_provider_check;
ALTER TABLE manual_application_fetch_receipts
  ADD CONSTRAINT manual_application_fetch_receipts_provider_check
  CHECK (provider IN ('ASHBY', 'GREENHOUSE', 'LEVER', 'EMPLOYER_WEBSITE', 'LINKEDIN'));
