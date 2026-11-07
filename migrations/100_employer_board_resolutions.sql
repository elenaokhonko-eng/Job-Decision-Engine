-- Migration 100: employer public job-board resolution cache.
--
-- LinkedIn job pages cannot be read without signing in, so a LinkedIn-discovered job is looked
-- up on the employer's own public ATS board (Greenhouse, Lever or Ashby; see
-- src/ingestion/employerBoardLookup.ts). Resolving an employer to its board takes several
-- probe requests, so each resolution is cached here, positive (FOUND, 30 days) and negative
-- (NOT_FOUND, 7 days), and reused for every job of that employer until it expires.
--
-- Rows hold only public board identifiers (provider and board token) keyed by the normalized
-- employer name. They are not job data and not workspace data. Network or HTTP failures are
-- never cached.
--
-- Rollback: set EMPLOYER_BOARD_LOOKUP_ENABLED=false to stop the lookup. The table is a cache;
-- it can be left in place, or removed with `DROP TABLE IF EXISTS employer_board_resolutions;`
-- without losing any job, observation or task history.

CREATE TABLE IF NOT EXISTS employer_board_resolutions (
  employer_key TEXT PRIMARY KEY CHECK (BTRIM(employer_key) <> '' AND LENGTH(employer_key) <= 300),
  employer_name TEXT NOT NULL CHECK (BTRIM(employer_name) <> '' AND LENGTH(employer_name) <= 500),
  status TEXT NOT NULL CHECK (status IN ('FOUND', 'NOT_FOUND')),
  provider TEXT CHECK (provider IS NULL OR provider IN ('GREENHOUSE', 'LEVER', 'ASHBY')),
  board_token TEXT CHECK (board_token IS NULL OR board_token ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$'),
  board_name TEXT CHECK (board_name IS NULL OR LENGTH(board_name) <= 500),
  resolution_method TEXT NOT NULL CHECK (resolution_method IN ('CONFIG', 'DERIVED_SLUG', 'NONE')),
  candidates_tried JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(candidates_tried) = 'array'),
  resolver_version TEXT NOT NULL CHECK (BTRIM(resolver_version) <> ''),
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > resolved_at),
  CHECK (
    (status = 'FOUND' AND provider IS NOT NULL AND board_token IS NOT NULL AND resolution_method <> 'NONE')
    OR (status = 'NOT_FOUND' AND provider IS NULL AND board_token IS NULL AND resolution_method = 'NONE')
  )
);

CREATE INDEX IF NOT EXISTS idx_employer_board_resolutions_expires_at
  ON employer_board_resolutions (expires_at);
