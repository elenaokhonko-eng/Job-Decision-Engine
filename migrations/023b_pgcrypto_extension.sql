-- Migration 023b: pgcrypto extension (required for digest/sha256 helpers)
--
-- CI failures on 024_* can occur when pgcrypto is not enabled:
--   function digest(unknown, unknown) does not exist
--
-- This migration is intentionally placed before 024_* so requirement-set hashing
-- can rely on pgcrypto's digest() function.

-- Install into public to avoid creating extension objects in per-test schemas.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
