ALTER TABLE embedding_inputs
  DROP CONSTRAINT IF EXISTS embedding_inputs_source_type_check;

ALTER TABLE embedding_inputs
  ADD CONSTRAINT embedding_inputs_source_type_check
  CHECK (source_type IN ('PROFILE_FACT', 'JOB_REQUIREMENT', 'JOB_VERSION', 'LANE_PROTOTYPE'));
