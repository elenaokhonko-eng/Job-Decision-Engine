-- Migration 105: store a FILTERED posting's raw payload once, and allow retention to release it.
--
-- The adapter runner writes one source_candidate_dispositions row per lane for every fetched
-- posting, and each row used to carry the full raw payload, so a posting filtered for four lanes
-- stored its payload four times. With DISCOVERY_FILTERED_PAYLOAD_DEDUPE_ENABLED=true the first
-- FILTERED row of a posting keeps the payload and the other FILTERED rows of that posting point
-- at it through raw_payload_disposition_id; every row still keeps raw_payload_hash, source URL,
-- external id and reason, and the reference rows also record the posting title and location.
--
-- scripts/release_filtered_disposition_payloads.ts (dry run by default) may later set
-- raw_payload to NULL on FILTERED rows older than 30 days and stamp raw_payload_released_at.
-- Only FILTERED rows may lose their payload; STAGED, DUPLICATE, QUARANTINED and ERROR rows keep
-- theirs (the constraint below enforces it), and observations are untouched.
--
-- Additive: existing rows keep their payloads and satisfy both constraints as written.
--
-- Rollback (only while no row has a NULL raw_payload; once payloads are released or shared the
-- NOT NULL constraint cannot be restored without the payloads):
--   ALTER TABLE source_candidate_dispositions DROP CONSTRAINT IF EXISTS source_candidate_dispositions_payload_presence_chk;
--   ALTER TABLE source_candidate_dispositions DROP CONSTRAINT IF EXISTS source_candidate_dispositions_payload_ref_fk;
--   DROP INDEX IF EXISTS idx_source_candidate_dispositions_filtered_payload_retention;
--   DROP INDEX IF EXISTS idx_source_candidate_dispositions_payload_ref;
--   ALTER TABLE source_candidate_dispositions
--     DROP COLUMN IF EXISTS raw_payload_disposition_id,
--     DROP COLUMN IF EXISTS posting_title,
--     DROP COLUMN IF EXISTS posting_location,
--     DROP COLUMN IF EXISTS raw_payload_released_at;
--   ALTER TABLE source_candidate_dispositions ALTER COLUMN raw_payload SET NOT NULL;

ALTER TABLE source_candidate_dispositions
  ADD COLUMN IF NOT EXISTS raw_payload_disposition_id UUID,
  ADD COLUMN IF NOT EXISTS posting_title TEXT,
  ADD COLUMN IF NOT EXISTS posting_location TEXT,
  ADD COLUMN IF NOT EXISTS raw_payload_released_at TIMESTAMPTZ;

ALTER TABLE source_candidate_dispositions ALTER COLUMN raw_payload DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'source_candidate_dispositions'
      AND constraint_name = 'source_candidate_dispositions_payload_ref_fk'
  ) THEN
    ALTER TABLE source_candidate_dispositions
      ADD CONSTRAINT source_candidate_dispositions_payload_ref_fk
      FOREIGN KEY (raw_payload_disposition_id) REFERENCES source_candidate_dispositions(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'source_candidate_dispositions'
      AND constraint_name = 'source_candidate_dispositions_payload_presence_chk'
  ) THEN
    -- A row without a payload is FILTERED and either shares another row's payload or had its
    -- payload released by retention. A sharing row never also carries its own payload.
    ALTER TABLE source_candidate_dispositions
      ADD CONSTRAINT source_candidate_dispositions_payload_presence_chk
      CHECK (
        (raw_payload IS NOT NULL AND raw_payload_disposition_id IS NULL)
        OR (
          raw_payload IS NULL
          AND disposition = 'FILTERED'
          AND (raw_payload_disposition_id IS NOT NULL OR raw_payload_released_at IS NOT NULL)
        )
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_source_candidate_dispositions_filtered_payload_retention
  ON source_candidate_dispositions (workspace_id, fetched_at)
  WHERE disposition = 'FILTERED' AND raw_payload IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_source_candidate_dispositions_payload_ref
  ON source_candidate_dispositions (raw_payload_disposition_id)
  WHERE raw_payload_disposition_id IS NOT NULL;

COMMENT ON COLUMN source_candidate_dispositions.raw_payload_disposition_id IS
  'FILTERED row whose raw_payload holds this posting''s payload (set instead of a duplicate payload).';
COMMENT ON COLUMN source_candidate_dispositions.raw_payload_released_at IS
  'When retention set raw_payload to NULL on this FILTERED row; raw_payload_hash is kept.';
