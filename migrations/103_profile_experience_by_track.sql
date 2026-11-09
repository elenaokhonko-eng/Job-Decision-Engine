-- Migration 103: candidate experience by career track.
--
-- A candidate's experience differs by track (for example many years in data management but
-- little hands-on ML engineering). The recommendation decider compares a job's level with the
-- candidate's years in the job's track, and the AI evaluation prompt receives the same figures,
-- so transition roles are not treated as a step down.
--
-- The value is the validated `experience_by_track` array from profile.json:
--   [{"track": "DATA_MANAGEMENT", "years": 20, "label": "..."}, ...]
-- NULL means the profile states no tracks; no track-based seniority floor is applied then.
-- The column is additive and nullable, so existing profile versions and older writers are unaffected.
--
-- Rollback (drops only the new column; no other data changes):
--   ALTER TABLE profile_versions DROP COLUMN IF EXISTS experience_by_track;

ALTER TABLE profile_versions
  ADD COLUMN IF NOT EXISTS experience_by_track JSONB
  CONSTRAINT profile_versions_experience_by_track_array_check
  CHECK (experience_by_track IS NULL OR jsonb_typeof(experience_by_track) = 'array');
