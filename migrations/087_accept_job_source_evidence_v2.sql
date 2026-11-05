-- Migration 087: accept version 2 of normalized job source evidence.
--
-- This changes only the schema-version checks. Existing v1 JSON and version values are
-- untouched; the equality check continues to require the JSON version to match its column.
--
-- Safe rollback (only while no v2 evidence has been stored in either table):
-- BEGIN;
-- DO $rollback$
-- BEGIN
--   IF EXISTS (
--        SELECT 1 FROM raw_job_observations
--        WHERE evidence_schema_version = 'job_source_evidence_v2'
--           OR normalized_evidence->>'schema_version' = 'job_source_evidence_v2'
--      )
--      OR EXISTS (
--        SELECT 1 FROM source_candidate_dispositions
--        WHERE evidence_schema_version = 'job_source_evidence_v2'
--           OR normalized_evidence->>'schema_version' = 'job_source_evidence_v2'
--      ) THEN
--     RAISE EXCEPTION 'Cannot roll back migration 087 while v2 evidence exists';
--   END IF;
-- END;
-- $rollback$;
-- ALTER TABLE raw_job_observations
--   DROP CONSTRAINT IF EXISTS raw_job_observations_normalized_evidence_chk,
--   ADD CONSTRAINT raw_job_observations_normalized_evidence_chk
--   CHECK (
--     (normalized_evidence IS NULL AND evidence_schema_version IS NULL)
--     OR (
--       jsonb_typeof(normalized_evidence) = 'object'
--       AND evidence_schema_version = 'job_source_evidence_v1'
--       AND normalized_evidence->>'schema_version' = evidence_schema_version
--     )
--   );
-- ALTER TABLE source_candidate_dispositions
--   DROP CONSTRAINT IF EXISTS source_candidate_dispositions_normalized_evidence_chk,
--   ADD CONSTRAINT source_candidate_dispositions_normalized_evidence_chk
--   CHECK (
--     (normalized_evidence IS NULL AND evidence_schema_version IS NULL)
--     OR (
--       jsonb_typeof(normalized_evidence) = 'object'
--       AND evidence_schema_version = 'job_source_evidence_v1'
--       AND normalized_evidence->>'schema_version' = evidence_schema_version
--     )
--   );
-- COMMIT;

ALTER TABLE raw_job_observations
  DROP CONSTRAINT IF EXISTS raw_job_observations_normalized_evidence_chk,
  ADD CONSTRAINT raw_job_observations_normalized_evidence_chk
  CHECK (
    (normalized_evidence IS NULL AND evidence_schema_version IS NULL)
    OR (
      jsonb_typeof(normalized_evidence) = 'object'
      AND evidence_schema_version IN ('job_source_evidence_v1', 'job_source_evidence_v2')
      AND normalized_evidence->>'schema_version' = evidence_schema_version
    )
  );

ALTER TABLE source_candidate_dispositions
  DROP CONSTRAINT IF EXISTS source_candidate_dispositions_normalized_evidence_chk,
  ADD CONSTRAINT source_candidate_dispositions_normalized_evidence_chk
  CHECK (
    (normalized_evidence IS NULL AND evidence_schema_version IS NULL)
    OR (
      jsonb_typeof(normalized_evidence) = 'object'
      AND evidence_schema_version IN ('job_source_evidence_v1', 'job_source_evidence_v2')
      AND normalized_evidence->>'schema_version' = evidence_schema_version
    )
  );
