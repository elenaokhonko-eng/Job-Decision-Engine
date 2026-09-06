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

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- In many environments pgcrypto already provides digest(text, text). When it does,
-- it is owned by the extension owner (often a superuser), so attempting to
-- CREATE OR REPLACE will fail with "must be owner of function digest".
--
-- Only create the overload when it's missing.
DO $do$
BEGIN
  IF to_regprocedure('public.digest(text, text)') IS NULL THEN
    EXECUTE $sql$
      CREATE FUNCTION digest(data text, type text)
      RETURNS bytea
      LANGUAGE sql
      IMMUTABLE
      STRICT
      AS $fn$
        SELECT digest(convert_to(data, 'UTF8'), type);
      $fn$;
    $sql$;
  END IF;
END
$do$;
