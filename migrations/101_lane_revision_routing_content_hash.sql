-- Migration 101: routing-content hash for lane revisions.
--
-- A lane revision's content holds both routing inputs (prototypes, scope concepts, routing
-- thresholds, descriptions) and the per-run AI budget (`budget`). Changing only the budget
-- (scripts/workspace_lanes.ts set-budget) mints and activates a new revision, which used to make
-- every previously routed job look routed under a superseded revision, so the evaluation enqueuer
-- refused all of them until each job happened to be re-routed.
--
-- routing_content_hash is the SHA-256 of the revision content without its top-level `budget`
-- key, rendered as PostgreSQL's canonical jsonb text (keys sorted, fixed spacing). Two revisions
-- with the same routing_content_hash route identically; they differ at most in budget. Revision
-- ids and content_hash are unchanged and remain the audit identity of each revision.
--
-- The column is GENERATED ... STORED, so existing rows are filled deterministically by the
-- ALTER TABLE (no UPDATE runs, so the lane_revisions immutability trigger is not involved) and
-- every future revision gets the same computation. convert_to(..., 'UTF8') is declared STABLE by
-- PostgreSQL only because it depends on the server encoding; with a fixed target encoding and a
-- fixed server encoding the result is deterministic, so the wrapper is declared IMMUTABLE.
--
-- Rollback (no data is lost; the column is derived from content):
--   ALTER TABLE lane_revisions DROP COLUMN IF EXISTS routing_content_hash;
--   DROP FUNCTION IF EXISTS lane_routing_content_hash(jsonb);

CREATE OR REPLACE FUNCTION lane_routing_content_hash(content jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to((content - 'budget')::text, 'UTF8')),
    'hex'
  )
$$;

ALTER TABLE lane_revisions
  ADD COLUMN IF NOT EXISTS routing_content_hash TEXT
  GENERATED ALWAYS AS (lane_routing_content_hash(content)) STORED;

CREATE INDEX IF NOT EXISTS idx_lane_revisions_identity_routing_hash
  ON lane_revisions(lane_identity_id, routing_content_hash);
