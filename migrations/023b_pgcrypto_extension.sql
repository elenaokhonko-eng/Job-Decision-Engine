-- Migration 023b: pgcrypto extension (required for digest/sha256 helpers)
--
-- CI failures on 024_* can occur when pgcrypto is not enabled:
--   function digest(unknown, unknown) does not exist
--
-- This migration is intentionally placed before 024_* so requirement-set hashing
-- can rely on pgcrypto's digest() function.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

COMMIT;

