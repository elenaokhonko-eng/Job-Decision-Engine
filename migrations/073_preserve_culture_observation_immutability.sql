-- Migration 073: preserve append-only culture observations during validated evaluation inserts.
--
-- The legacy materializer still records policy-recheck tasks. Skip only its unverified
-- culture row for evaluations that carry the deterministic scoring-version marker; the
-- validated culture trigger then inserts the immutable observation.

CREATE OR REPLACE FUNCTION skip_unverified_culture_observation_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_type = 'CURRENT_JOB_DESCRIPTION_EVALUATION'
     AND EXISTS (
       SELECT 1
       FROM ai_evaluations AS evaluation
       WHERE evaluation.workspace_id = NEW.workspace_id
         AND evaluation.id = NEW.ai_evaluation_id
         AND evaluation.full_evaluation_payload ->> 'culture_score_derivation_version'
           = 'quote_phrase_rules_v1'
     ) THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_skip_unverified_culture_observation_insert
  ON company_culture_observations;
CREATE TRIGGER trg_skip_unverified_culture_observation_insert
BEFORE INSERT ON company_culture_observations
FOR EACH ROW EXECUTE FUNCTION skip_unverified_culture_observation_insert();

COMMENT ON FUNCTION skip_unverified_culture_observation_insert() IS
  'Prevents the legacy AI-score materializer from inserting an unverified culture row when a deterministic quote-rule evaluation will insert the immutable replacement.';
