-- Public-source discovery stores "<plan_version>:<source_plugin_revision_id>" (scripts/run_adapters.ts),
-- e.g. "six_lane_sources_v1:" plus a 36-character revision UUID = 56 characters. The column was created
-- as VARCHAR(50) in 002/003, so every public-source observation failed to stage with
-- "value too long for type character varying(50)". The JobObservation contract has no length limit.
--
-- Widening is additive: no stored value changes. To reverse, run
--   ALTER TABLE raw_job_observations ALTER COLUMN search_plan_version TYPE VARCHAR(50);
-- only after confirming no stored value exceeds 50 characters.
ALTER TABLE raw_job_observations
  ALTER COLUMN search_plan_version TYPE TEXT;
