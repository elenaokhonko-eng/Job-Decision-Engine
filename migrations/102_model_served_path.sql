-- Migration 102: record which path served each model call.
--
-- Pipeline calls on Vertex Flex PayGo now run in a fixed order: Gemini Flex first; after a Flex
-- timeout, 429/RESOURCE_EXHAUSTED or unavailability, one standard PayGo request on the same Gemini
-- model; only then the OpenAI fallback. served_path records the path that answered:
--
--   FLEX             Gemini on Vertex Flex PayGo
--   STANDARD         Gemini on standard PayGo (a non-Flex call, or the standard retry after Flex)
--   OPENAI           OpenAI as the route's primary provider
--   OPENAI_FALLBACK  OpenAI after Gemini failed (the only degraded path for an evaluation)
--
-- NULL means the path was not recorded: rows written before this migration, and failed calls.
-- Both columns are additive and nullable, so existing rows and older writers are unaffected.
--
-- Rollback (drops only the new columns; no other data changes):
--   ALTER TABLE ai_evaluations DROP COLUMN IF EXISTS served_path;
--   ALTER TABLE model_route_invocations DROP COLUMN IF EXISTS served_path;

ALTER TABLE model_route_invocations
  ADD COLUMN IF NOT EXISTS served_path TEXT
  CONSTRAINT model_route_invocations_served_path_check
  CHECK (served_path IS NULL OR served_path IN ('FLEX', 'STANDARD', 'OPENAI', 'OPENAI_FALLBACK'));

ALTER TABLE ai_evaluations
  ADD COLUMN IF NOT EXISTS served_path TEXT
  CONSTRAINT ai_evaluations_served_path_check
  CHECK (served_path IS NULL OR served_path IN ('FLEX', 'STANDARD', 'OPENAI', 'OPENAI_FALLBACK'));
