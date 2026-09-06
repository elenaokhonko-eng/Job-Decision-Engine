-- Migration 023c: pgcrypto digest(text, text) helper
--
-- Some migrations (e.g., 024_requirement_sets_and_corrections.sql) compute SHA-256
-- hashes using `digest(<text>, 'sha256')`. The pgcrypto extension provides
-- `digest(bytea, text)`, so calling `digest(text, text)` fails unless the caller
-- explicitly converts text to bytea.
--
-- This additive migration defines a safe overload:
--   digest(text, text) -> digest(convert_to(text,'UTF8'), algo)
-- so earlier migrations do not need to be edited.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION digest(data text, type text)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT digest(convert_to(data, 'UTF8'), type);
$$;

COMMIT;

