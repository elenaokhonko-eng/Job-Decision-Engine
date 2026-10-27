-- Migration 079: allow versioned user contact facts in the authoritative profile graph.
-- Existing profile facts, revisions, and snapshots are retained; only the accepted enum values change.
--
-- Safe rollback (only after CONTACT writes stop and no CONTACT facts remain):
-- BEGIN;
-- DO $$ BEGIN
--   IF EXISTS (SELECT 1 FROM profile_facts WHERE fact_type = 'CONTACT') THEN
--     RAISE EXCEPTION 'Cannot roll back CONTACT fact support while CONTACT facts exist';
--   END IF;
-- END $$;
-- ALTER TABLE profile_facts DROP CONSTRAINT profile_facts_fact_type_check;
-- ALTER TABLE profile_facts ADD CONSTRAINT profile_facts_fact_type_check CHECK (
--   fact_type IN (
--     'ACHIEVEMENT', 'RESPONSIBILITY', 'PROJECT', 'SKILL',
--     'DOMAIN', 'TECHNOLOGY', 'PUBLICATION', 'OPEN_SOURCE'
--   )
-- );
-- COMMIT;

ALTER TABLE profile_facts
  DROP CONSTRAINT profile_facts_fact_type_check;

ALTER TABLE profile_facts
  ADD CONSTRAINT profile_facts_fact_type_check CHECK (
    fact_type IN (
      'ACHIEVEMENT', 'RESPONSIBILITY', 'PROJECT', 'SKILL',
      'DOMAIN', 'TECHNOLOGY', 'PUBLICATION', 'OPEN_SOURCE', 'CONTACT'
    )
  );
