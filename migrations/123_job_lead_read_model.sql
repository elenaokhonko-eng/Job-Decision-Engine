-- Migration 123: job-board and aggregator jobs are stored as leads and leave every ranked list.
--
-- A LEAD is a job known only from job boards or aggregators. It stays stored with its observations, decisions and
-- history (nothing is rejected, deleted or rewritten) and is left out of the shortlist and everything built on it
-- (Review, Priority, Apply Now, Top 10, Track, status buckets), the AI queue and the review draw.
--
-- THE ONE DEFINITION is v_job_lead_state.is_lead:
--       (some sighting of the job is on a JOB_BOARD or AGGREGATOR host, or comes from a JOB_BOARD source)
--   AND no observation of the job is the employer's own posting (EMPLOYER source whose source_url is not on a
--       job board or aggregator)
--   AND no observation of the job was provided by the owner (OWNER source)
--   AND no sighting of the job is on a NOT_LEAD host or from a NOT_LEAD source.
-- A sighting is canonical_jobs.canonical_url, or source_url / canonical_apply_url / source_name of any observation
-- of any version of the job (and of the observation it was derived from). Amazon SES click tracking is looked through.
-- Every host and source entry is a row of v_job_lead_rules, so a decision is changed in exactly one place.
--
-- OWNER DECISION PENDING: MyCareersFuture. It is on AGGREGATOR_HOSTS (src/ingestion/aggregatorHosts.ts), and it is
-- NOT a lead here until the owner decides, so no job disappears first. To make it one, change the single
-- 'mycareersfuture.gov.sg' row of v_job_lead_rules from NOT_LEAD to AGGREGATOR (before this migration is applied,
-- or with a CREATE OR REPLACE of that view in a later one). LinkedIn is not a lead by owner decision.
--
-- Additive: three new views and one replaced view with the same columns. No table, column or row changes.
-- src/tests/ingestion/jobLeadReadModel.integration.test.ts checks the entries against AGGREGATOR_HOSTS and the
-- source vocabulary.
--
-- Rollback order: roll this migration back before migration 120, whose view v_job_content_state it reads.
--
-- Contract (amends migration 120): a live job is in exactly one of (a) a status bucket of
-- v_job_status_buckets_scoped, (b) v_job_awaiting_content_scoped, or (c) v_job_leads_scoped. A hard-rejected or
-- removed lead stays in its REJECTED / REMOVED bucket; a lead without complete content waits in (b).
--
-- Rollback (exact; the test runs it): run the CREATE OR REPLACE VIEW v_canonical_shortlist_scoped statement of
-- migrations/120_awaiting_content_read_model.sql, then
--   DROP VIEW IF EXISTS v_job_leads_scoped;
--   DROP VIEW IF EXISTS v_job_lead_state;
--   DROP VIEW IF EXISTS v_job_lead_rules;

CREATE OR REPLACE VIEW v_job_lead_rules AS
SELECT rules.rule_kind, rules.match_value, rules.treatment
FROM (VALUES
  ('HOST', 'himalayas.app', 'JOB_BOARD'),
  ('HOST', 'jobicy.com', 'JOB_BOARD'),
  ('HOST', 'remotive.com', 'JOB_BOARD'),
  ('HOST', 'remotive.io', 'JOB_BOARD'),
  ('HOST', 'weworkremotely.com', 'JOB_BOARD'),
  ('HOST', 'news.ycombinator.com', 'JOB_BOARD'),
  ('HOST', 'startup.jobs', 'JOB_BOARD'),
  ('HOST', 'swda.gov.sg', 'AGGREGATOR'),
  ('HOST', 'indeed.com', 'AGGREGATOR'),
  ('HOST', 'glassdoor.com', 'AGGREGATOR'),
  ('HOST', 'jobstreet.com', 'AGGREGATOR'),
  ('HOST', 'jobsdb.com', 'AGGREGATOR'),
  ('HOST', 'ziprecruiter.com', 'AGGREGATOR'),
  ('HOST', 'monster.com', 'AGGREGATOR'),
  ('HOST', 'simplyhired.com', 'AGGREGATOR'),
  ('HOST', 'efinancialcareers.com', 'AGGREGATOR'),
  ('HOST', 'jobbank.gov.sg', 'AGGREGATOR'),
  -- OWNER DECISION PENDING (see the header): change NOT_LEAD to AGGREGATOR to make MyCareersFuture jobs leads.
  ('HOST', 'mycareersfuture.gov.sg', 'NOT_LEAD'),
  -- Owner decision: LinkedIn jobs stay ranked.
  ('HOST', 'linkedin.com', 'NOT_LEAD'),
  ('HOST', 'lnkd.in', 'NOT_LEAD'),
  ('SOURCE', 'LINKEDIN', 'NOT_LEAD'),
  ('SOURCE', 'EMPLOYER_WEBSITE', 'EMPLOYER'),
  ('SOURCE', 'GREENHOUSE', 'EMPLOYER'),
  ('SOURCE', 'LEVER', 'EMPLOYER'),
  ('SOURCE', 'ASHBY', 'EMPLOYER'),
  ('SOURCE', 'WORKABLE', 'EMPLOYER'),
  ('SOURCE', 'SMARTRECRUITERS', 'EMPLOYER'),
  ('SOURCE', 'WORKDAY', 'EMPLOYER'),
  ('SOURCE', 'LINKEDIN_SAVED', 'OWNER'),
  ('SOURCE', 'MCF_SAVED', 'OWNER'),
  ('SOURCE', 'MANUAL_IMPORT', 'OWNER'),
  ('SOURCE', 'MANUAL_STREAMLIT', 'OWNER'),
  ('SOURCE', 'HIMALAYAS', 'JOB_BOARD'),
  ('SOURCE', 'JOBICY', 'JOB_BOARD'),
  ('SOURCE', 'REMOTIVE', 'JOB_BOARD'),
  ('SOURCE', 'WE_WORK_REMOTELY', 'JOB_BOARD'),
  ('SOURCE', 'STARTUP_JOBS', 'JOB_BOARD'),
  ('SOURCE', 'HACKER_NEWS', 'JOB_BOARD'),
  -- An alert counts only through the link it carries.
  ('SOURCE', 'GMAIL_ALERT', 'ALERT')
) AS rules(rule_kind, match_value, treatment);

CREATE OR REPLACE VIEW v_job_lead_state AS
SELECT
  job.workspace_id,
  job.id AS canonical_job_id,
  verdict.is_lead,
  CASE
    WHEN NOT verdict.is_lead THEN NULL
    WHEN facts.on_job_board THEN 'JOB_BOARD'
    ELSE 'AGGREGATOR'
  END AS lead_kind,
  facts.on_job_board,
  facts.on_aggregator,
  facts.has_employer_posting,
  facts.has_owner_posting,
  facts.has_not_lead_sighting
FROM canonical_jobs job
CROSS JOIN LATERAL (
  SELECT
    COALESCE(BOOL_OR(host_rule.treatment = 'JOB_BOARD' OR source_rule.treatment = 'JOB_BOARD'), FALSE) AS on_job_board,
    COALESCE(BOOL_OR(host_rule.treatment = 'AGGREGATOR'), FALSE) AS on_aggregator,
    COALESCE(BOOL_OR(
      source_rule.treatment = 'EMPLOYER'
      AND sighting.is_source_link
      AND COALESCE(host_rule.treatment, '') NOT IN ('JOB_BOARD', 'AGGREGATOR')
    ), FALSE) AS has_employer_posting,
    COALESCE(BOOL_OR(source_rule.treatment = 'OWNER'), FALSE) AS has_owner_posting,
    COALESCE(BOOL_OR(host_rule.treatment = 'NOT_LEAD' OR source_rule.treatment = 'NOT_LEAD'), FALSE) AS has_not_lead_sighting
  FROM (
    SELECT NULL::text AS source_name, job.canonical_url::text AS link, FALSE AS is_source_link
    UNION ALL
    SELECT seen.source_name::text, address.link::text, address.is_source_link
    FROM job_versions version
    JOIN raw_job_observations observation
      ON observation.workspace_id = version.workspace_id
     AND observation.job_version_id = version.id
    -- The observation itself, and the one it was derived from (an alert whose posting was fetched).
    CROSS JOIN LATERAL (VALUES (observation.id), (observation.derived_from_observation_id)) AS related(id)
    JOIN raw_job_observations seen
      ON seen.id = related.id
     AND seen.workspace_id = observation.workspace_id
    CROSS JOIN LATERAL (VALUES (seen.source_url::text, TRUE), (seen.canonical_apply_url::text, FALSE)) AS address(link, is_source_link)
    WHERE version.workspace_id = job.workspace_id
      AND version.canonical_job_id = job.id
  ) sighting
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN sighting.link ~* '^https?://[^/?#]*awstrack[.]me/L0/'
        THEN regexp_replace(regexp_replace(substring(sighting.link from '/L0/([^/]+)'), '%3a', ':', 'gi'), '%2f', '/', 'gi')
      ELSE sighting.link
    END AS link
  ) unwrapped
  CROSS JOIN LATERAL (
    SELECT RTRIM(LOWER(substring(unwrapped.link from '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^/@?#]*@)?([^/:?#]+)')), '.') AS host
    -- OFFSET 0 keeps the host from being recomputed for every rule it is compared with.
    OFFSET 0
  ) address_host
  LEFT JOIN v_job_lead_rules host_rule
    ON host_rule.rule_kind = 'HOST'
   AND (address_host.host = host_rule.match_value
        OR RIGHT(address_host.host, LENGTH(host_rule.match_value) + 1) = '.' || host_rule.match_value)
  LEFT JOIN v_job_lead_rules source_rule
    ON source_rule.rule_kind = 'SOURCE'
   AND source_rule.match_value = sighting.source_name
) facts
CROSS JOIN LATERAL (
  SELECT (facts.on_job_board OR facts.on_aggregator)
    AND NOT facts.has_employer_posting
    AND NOT facts.has_owner_posting
    AND NOT facts.has_not_lead_sighting AS is_lead
) verdict;

CREATE OR REPLACE VIEW v_canonical_shortlist_scoped AS
SELECT
  canonical.workspace_id,
  shortlist.*,
  CASE
    WHEN blocked.blocked_task_count > 0 THEN 'BLOCKED_DEPENDENCY'
    WHEN shortlist.gate_status = 'PASS' AND (
      active_profile.id IS NULL
      OR target_version.active_requirement_set_id IS NULL
      OR match_run.id IS NULL
      OR match_run.status <> 'COMPLETED'
      OR match_run.canonical_job_id IS DISTINCT FROM canonical.id
      OR match_run.job_version_id IS DISTINCT FROM target_version.id
      OR match_run.profile_version_id IS DISTINCT FROM active_profile.id
      OR match_run.requirement_set_id IS DISTINCT FROM target_version.active_requirement_set_id
      OR match_run.job_content_hash IS DISTINCT FROM target_version.content_hash
      OR match_run.context_fingerprint IS NULL
    ) THEN 'MATCH_STALE'
    WHEN shortlist.gate_status = 'PASS' AND (
      deterministic_decision.id IS NULL
      OR deterministic_decision.canonical_job_id IS DISTINCT FROM canonical.id
      OR deterministic_decision.job_version_id IS DISTINCT FROM target_version.id
      OR deterministic_decision.match_run_id IS DISTINCT FROM match_run.id
      OR deterministic_decision.context_fingerprint IS NULL
    ) THEN 'DECISION_STALE'
    WHEN shortlist.gate_status = 'PASS' AND latest_evaluation.id IS NULL THEN 'EVALUATION_MISSING'
    WHEN shortlist.gate_status = 'PASS' AND (
      latest_evaluation.profile_version_id IS DISTINCT FROM active_profile.id
      OR latest_evaluation.canonical_job_id IS DISTINCT FROM canonical.id
      OR latest_evaluation.job_version_id IS DISTINCT FROM target_version.id
      OR latest_evaluation.match_run_id IS DISTINCT FROM match_run.id
      OR latest_evaluation.deterministic_decision_id IS DISTINCT FROM deterministic_decision.id
      OR latest_evaluation.job_content_hash IS DISTINCT FROM target_version.content_hash
      OR latest_evaluation.context_fingerprint IS NULL
    ) THEN 'EVALUATION_STALE'
    WHEN shortlist.version_mismatch THEN 'EVALUATION_STALE'
    ELSE 'CURRENT_OR_NOT_APPLICABLE'
  END AS current_artifact_status,
  CASE
    WHEN blocked.blocked_task_count > 0 THEN blocked.blocked_reason
    WHEN shortlist.gate_status = 'PASS' AND active_profile.id IS NULL THEN 'NO_ACTIVE_PROFILE'
    WHEN shortlist.gate_status = 'PASS' AND target_version.active_requirement_set_id IS NULL THEN 'NO_ACTIVE_REQUIREMENT_SET'
    WHEN shortlist.gate_status = 'PASS' AND match_run.id IS NULL THEN 'NO_CURRENT_MATCH_RUN'
    WHEN shortlist.gate_status = 'PASS' AND match_run.status <> 'COMPLETED' THEN 'MATCH_RUN_NOT_COMPLETED'
    WHEN shortlist.gate_status = 'PASS' AND match_run.canonical_job_id IS DISTINCT FROM canonical.id THEN 'MATCH_CANONICAL_JOB_STALE'
    WHEN shortlist.gate_status = 'PASS' AND match_run.job_version_id IS DISTINCT FROM target_version.id THEN 'MATCH_JOB_VERSION_STALE'
    WHEN shortlist.gate_status = 'PASS' AND match_run.profile_version_id IS DISTINCT FROM active_profile.id THEN 'MATCH_PROFILE_VERSION_STALE'
    WHEN shortlist.gate_status = 'PASS' AND match_run.requirement_set_id IS DISTINCT FROM target_version.active_requirement_set_id THEN 'MATCH_REQUIREMENT_SET_STALE'
    WHEN shortlist.gate_status = 'PASS' AND match_run.job_content_hash IS DISTINCT FROM target_version.content_hash THEN 'MATCH_JOB_CONTENT_STALE'
    WHEN shortlist.gate_status = 'PASS' AND match_run.context_fingerprint IS NULL THEN 'MATCH_CONTEXT_UNPROVABLE'
    WHEN shortlist.gate_status = 'PASS' AND deterministic_decision.id IS NULL THEN 'NO_CURRENT_DETERMINISTIC_DECISION'
    WHEN shortlist.gate_status = 'PASS' AND deterministic_decision.canonical_job_id IS DISTINCT FROM canonical.id THEN 'DECISION_CANONICAL_JOB_STALE'
    WHEN shortlist.gate_status = 'PASS' AND deterministic_decision.job_version_id IS DISTINCT FROM target_version.id THEN 'DECISION_JOB_VERSION_STALE'
    WHEN shortlist.gate_status = 'PASS' AND deterministic_decision.match_run_id IS DISTINCT FROM match_run.id THEN 'DECISION_MATCH_RUN_STALE'
    WHEN shortlist.gate_status = 'PASS' AND deterministic_decision.context_fingerprint IS NULL THEN 'DECISION_CONTEXT_UNPROVABLE'
    WHEN shortlist.gate_status = 'PASS' AND latest_evaluation.id IS NULL THEN 'NO_CURRENT_AI_EVALUATION'
    WHEN shortlist.gate_status = 'PASS' AND latest_evaluation.context_fingerprint IS NULL THEN 'EVALUATION_CONTEXT_UNPROVABLE'
    WHEN shortlist.version_mismatch THEN 'NO_CURRENT_EVALUATION_FOR_DISPLAYED_VERSION'
    ELSE NULL
  END AS current_artifact_reason,
  blocked.blocked_task_count
FROM canonical_jobs canonical
JOIN v_canonical_shortlist shortlist
  ON shortlist.canonical_job_id = canonical.id
LEFT JOIN LATERAL (
  SELECT version.id, version.active_requirement_set_id, version.content_hash
  FROM job_versions version
  WHERE version.workspace_id = canonical.workspace_id
    AND version.id = shortlist.job_version_id::uuid
  LIMIT 1
) target_version ON TRUE
LEFT JOIN LATERAL (
  SELECT profile.id
  FROM profile_versions profile
  WHERE profile.workspace_id = canonical.workspace_id
    AND profile.status = 'ACTIVE'
  ORDER BY profile.created_at DESC
  LIMIT 1
) active_profile ON TRUE
LEFT JOIN LATERAL (
  SELECT candidate.id, candidate.status, candidate.canonical_job_id,
         candidate.job_version_id, candidate.profile_version_id,
         candidate.requirement_set_id, candidate.job_content_hash,
         candidate.context_fingerprint
  FROM match_runs candidate
  WHERE candidate.workspace_id = canonical.workspace_id
    AND candidate.id = canonical.latest_match_run_id
  LIMIT 1
) match_run ON TRUE
LEFT JOIN LATERAL (
  SELECT candidate.id, candidate.canonical_job_id, candidate.job_version_id,
         candidate.match_run_id, candidate.context_fingerprint
  FROM deterministic_decisions candidate
  WHERE candidate.workspace_id = canonical.workspace_id
    AND candidate.id = canonical.latest_deterministic_decision_id
  LIMIT 1
) deterministic_decision ON TRUE
LEFT JOIN LATERAL (
  SELECT candidate.id, candidate.canonical_job_id, candidate.job_version_id,
         candidate.profile_version_id, candidate.match_run_id,
         candidate.deterministic_decision_id, candidate.job_content_hash,
         candidate.context_fingerprint
  FROM ai_evaluations candidate
  WHERE candidate.workspace_id = canonical.workspace_id
    AND candidate.canonical_job_id = canonical.id
    AND candidate.job_version_id = shortlist.job_version_id::uuid
  ORDER BY candidate.evaluated_at DESC, candidate.id DESC
  LIMIT 1
) latest_evaluation ON TRUE
LEFT JOIN LATERAL (
  SELECT COUNT(*)::int AS blocked_task_count,
         MAX(task.blocked_reason) AS blocked_reason
  FROM pipeline_tasks task
  WHERE task.workspace_id = canonical.workspace_id
    AND task.status = 'BLOCKED_DEPENDENCY'
    AND (task.payload->>'canonical_job_id' = canonical.id::text
      OR task.payload->>'job_version_id' = shortlist.job_version_id::text)
) blocked ON TRUE
WHERE canonical.is_test_fixture = FALSE
  AND canonical.archived_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM v_job_content_state content_state
    WHERE content_state.workspace_id = canonical.workspace_id
      AND content_state.canonical_job_id = canonical.id
      AND content_state.content_complete
  )
  -- Job-board and aggregator leads are stored, not ranked (v_job_lead_state is the one definition). A scalar
  -- subquery, so the definition is read only for the rows this view returns, through the job's own indexes.
  AND NOT COALESCE((
    SELECT lead.is_lead
    FROM v_job_lead_state lead
    WHERE lead.workspace_id = canonical.workspace_id
      AND lead.canonical_job_id = canonical.id
  ), FALSE);

-- The live leads that the lists leave out, so none of them disappears. Not a ranked list: it carries no score.
CREATE OR REPLACE VIEW v_job_leads_scoped AS
SELECT
  job.workspace_id,
  job.id AS canonical_job_id,
  content.job_version_id,
  job.normalized_title AS title,
  job.company_name AS company,
  job.canonical_url,
  lead.lead_kind,
  COALESCE(job.processing_state, job.processing_status) AS processing_state,
  EXISTS (
    SELECT 1 FROM application_records application
    WHERE application.workspace_id = job.workspace_id
      AND application.canonical_job_id = job.id
  ) AS in_application_tracker
FROM canonical_jobs job
JOIN v_job_lead_state lead
  ON lead.workspace_id = job.workspace_id
 AND lead.canonical_job_id = job.id
 AND lead.is_lead
JOIN v_job_content_state content
  ON content.workspace_id = job.workspace_id
 AND content.canonical_job_id = job.id
 AND content.content_complete
WHERE job.is_test_fixture = FALSE
  AND job.archived_at IS NULL
  AND COALESCE(job.processing_state, job.processing_status) NOT IN ('MANUALLY_REMOVED', 'HARD_REJECTED');

COMMENT ON VIEW v_job_lead_rules IS
  'The host and source entries of the lead definition (migration 123). JOB_BOARD and AGGREGATOR make a lead; EMPLOYER and OWNER observations and NOT_LEAD sightings keep a job ranked.';
COMMENT ON VIEW v_job_lead_state IS
  'THE definition of a lead, one row per canonical job: known only from job boards or aggregators, with no employer or owner-provided observation and no NOT_LEAD sighting. A lead is stored and keeps its history; it is never ranked, queued for AI or drawn for review.';
COMMENT ON VIEW v_job_leads_scoped IS
  'Live, content-complete leads that are left out of every list. in_application_tracker marks the ones the owner saved to the tracker.';
COMMENT ON VIEW v_canonical_shortlist_scoped IS
  'Active canonical shortlist only: posting content complete (v_job_content_state) and not a lead (v_job_lead_state). Archived jobs remain in v_archived_jobs_scoped, awaiting-content jobs in v_job_awaiting_content_scoped and leads in v_job_leads_scoped.';
