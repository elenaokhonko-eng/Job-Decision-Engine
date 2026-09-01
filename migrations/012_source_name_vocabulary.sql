-- Migration 012: Normalize known ingestion source aliases to canonical uppercase vocabulary.
-- Unknown historical values remain untouched for audit preservation.

UPDATE raw_job_observations
SET source_name = CASE LOWER(source_name)
  WHEN 'gmail' THEN 'GMAIL_ALERT'
  WHEN 'email_alert' THEN 'GMAIL_ALERT'
  WHEN 'gmail_alert' THEN 'GMAIL_ALERT'
  WHEN 'greenhouse' THEN 'GREENHOUSE'
  WHEN 'lever' THEN 'LEVER'
  WHEN 'ashby' THEN 'ASHBY'
  WHEN 'himalayas' THEN 'HIMALAYAS'
  WHEN 'jobicy' THEN 'JOBICY'
  WHEN 'remotive' THEN 'REMOTIVE'
  WHEN 'we_work_remotely' THEN 'WE_WORK_REMOTELY'
  WHEN 'startup_jobs' THEN 'STARTUP_JOBS'
  WHEN 'manual_import' THEN 'MANUAL_IMPORT'
  WHEN 'manual_streamlit' THEN 'MANUAL_STREAMLIT'
  WHEN 'linkedin' THEN 'LINKEDIN'
  ELSE source_name
END
WHERE LOWER(source_name) IN (
  'gmail', 'email_alert', 'gmail_alert', 'greenhouse', 'lever', 'ashby',
  'himalayas', 'jobicy', 'remotive', 'we_work_remotely', 'startup_jobs',
  'manual_import', 'manual_streamlit', 'linkedin'
);
