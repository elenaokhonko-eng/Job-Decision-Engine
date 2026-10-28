-- Migration 080: reversible job archiving and archive operations audit.
--
-- Archive state is independent of gate, recommendation, and application state. No job,
-- observation, version, decision, document, or application record is deleted or moved.
-- Rollback: disable archive writers and restore the previous active-list views while leaving
-- the archive columns, runs, holds, and event history intact. Do not drop archive history.

DROP INDEX IF EXISTS uq_job_versions_workspace_canonical_posting_identity;

ALTER TABLE canonical_jobs
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archive_reason TEXT,
  ADD COLUMN IF NOT EXISTS archive_age_basis TEXT,
  ADD COLUMN IF NOT EXISTS archive_reference_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'canonical_jobs'
      AND constraint_name = 'canonical_jobs_archive_metadata_check'
  ) THEN
    ALTER TABLE canonical_jobs
      ADD CONSTRAINT canonical_jobs_archive_metadata_check CHECK (
        (archived_at IS NULL
          AND archive_reason IS NULL
          AND archive_age_basis IS NULL
          AND archive_reference_at IS NULL)
        OR
        (archived_at IS NOT NULL
          AND NULLIF(BTRIM(archive_reason), '') IS NOT NULL
          AND archive_age_basis IS NOT NULL
          AND archive_age_basis IN (
            'GENUINE_REPOST_DATE',
            'AUTHORITATIVE_PUBLICATION_DATE',
            'OBSERVED_AGE_PUBLICATION_UNKNOWN'
          )
          AND archive_reference_at IS NOT NULL)
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_canonical_jobs_active_workspace
  ON canonical_jobs (workspace_id, id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_canonical_jobs_archived_workspace
  ON canonical_jobs (workspace_id, archived_at DESC, id)
  WHERE archived_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_archive_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_started_at TIMESTAMPTZ NOT NULL,
  cutoff_at TIMESTAMPTZ NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('DRY_RUN', 'APPLY')),
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  eligible_count INTEGER NOT NULL DEFAULT 0 CHECK (eligible_count >= 0),
  archived_count INTEGER NOT NULL DEFAULT 0 CHECK (archived_count >= 0),
  protected_count INTEGER NOT NULL DEFAULT 0 CHECK (protected_count >= 0),
  invalid_date_count INTEGER NOT NULL DEFAULT 0 CHECK (invalid_date_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  observed_age_publication_unknown_count INTEGER NOT NULL DEFAULT 0
    CHECK (observed_age_publication_unknown_count >= 0),
  report_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_summary JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CHECK (cutoff_at < run_started_at)
);

CREATE INDEX IF NOT EXISTS idx_job_archive_runs_status_started
  ON job_archive_runs (status, run_started_at DESC);

ALTER TABLE canonical_jobs
  ADD COLUMN IF NOT EXISTS archive_run_id UUID REFERENCES job_archive_runs(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'canonical_jobs'
      AND constraint_name = 'canonical_jobs_archive_run_id_check'
  ) THEN
    ALTER TABLE canonical_jobs
      ADD CONSTRAINT canonical_jobs_archive_run_id_check CHECK (
        (archived_at IS NULL AND archive_run_id IS NULL)
        OR (archived_at IS NOT NULL AND archive_run_id IS NOT NULL)
      );
  END IF;
END;
$$;

ALTER TABLE evaluation_queue
  ADD COLUMN IF NOT EXISTS skipped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS skip_reason_code TEXT;

CREATE TABLE IF NOT EXISTS job_archive_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE RESTRICT,
  archive_run_id UUID REFERENCES job_archive_runs(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('ARCHIVED', 'RESTORED', 'REPOST_REACTIVATED')),
  event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor TEXT NOT NULL CHECK (NULLIF(BTRIM(actor), '') IS NOT NULL),
  reason TEXT NOT NULL CHECK (NULLIF(BTRIM(reason), '') IS NOT NULL),
  reference_at TIMESTAMPTZ,
  age_basis TEXT CHECK (
    age_basis IS NULL OR age_basis IN (
      'GENUINE_REPOST_DATE',
      'AUTHORITATIVE_PUBLICATION_DATE',
      'OBSERVED_AGE_PUBLICATION_UNKNOWN'
    )
  ),
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_job_archive_events_job_time
  ON job_archive_events (workspace_id, canonical_job_id, event_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_job_archive_events_run
  ON job_archive_events (archive_run_id, event_at DESC)
  WHERE archive_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_archive_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE RESTRICT,
  hold_reason TEXT NOT NULL CHECK (NULLIF(BTRIM(hold_reason), '') IS NOT NULL),
  hold_type TEXT NOT NULL CHECK (hold_type IN ('USER_PRESERVE', 'AGENT2_PILOT', 'RESTORE_REASSESSMENT')),
  created_by TEXT NOT NULL CHECK (NULLIF(BTRIM(created_by), '') IS NOT NULL),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  released_by TEXT,
  release_reason TEXT,
  CHECK (expires_at > created_at),
  CHECK (
    (released_at IS NULL AND released_by IS NULL AND release_reason IS NULL)
    OR (released_at IS NOT NULL AND NULLIF(BTRIM(released_by), '') IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_job_archive_holds_active
  ON job_archive_holds (workspace_id, canonical_job_id, expires_at)
  WHERE released_at IS NULL;

CREATE OR REPLACE FUNCTION job_archive_event_immutable_guard() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'job_archive_events is append-only; insert a new archive event instead.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_job_archive_events_immutable ON job_archive_events;
CREATE TRIGGER trg_job_archive_events_immutable
BEFORE UPDATE OR DELETE ON job_archive_events
FOR EACH ROW EXECUTE FUNCTION job_archive_event_immutable_guard();

COMMENT ON COLUMN canonical_jobs.archived_at IS
  'Independent active-list and processing lifecycle flag; does not alter qualification, recommendation, or application status.';
COMMENT ON COLUMN canonical_jobs.archive_age_basis IS
  'GENUINE_REPOST_DATE, AUTHORITATIVE_PUBLICATION_DATE, or OBSERVED_AGE_PUBLICATION_UNKNOWN; the last means observed age; publication date unknown.';
COMMENT ON COLUMN canonical_jobs.archive_run_id IS
  'Apply-mode archive run that set the current archive lifecycle state; cleared only by an audited restore.';
COMMENT ON COLUMN evaluation_queue.skip_reason_code IS
  'Non-failure disposition reason for evaluation work skipped because its canonical job was archived.';
COMMENT ON TABLE job_archive_events IS
  'Append-only archive, restore, and genuine-repost reactivation audit events. All canonical evidence and application history remain in place.';
COMMENT ON TABLE job_archive_holds IS
  'Time-bounded workspace-scoped holds protecting selected jobs from automated archival.';
COMMENT ON TABLE job_archive_runs IS
  'Persisted dry-run and apply-mode counts and last-success operational reporting; dry-run never changes job or queue state.';

CREATE OR REPLACE VIEW v_archived_jobs_scoped AS
SELECT
  canonical.workspace_id,
  canonical.id AS canonical_job_id,
  canonical.latest_job_version_id AS job_version_id,
  COALESCE(canonical.normalized_title, 'Untitled role') AS title,
  COALESCE(canonical.company_name, 'Unknown company') AS company,
  canonical.canonical_url,
  COALESCE(canonical.location, canonical.location_summary, 'Unknown') AS location,
  canonical.workplace_type,
  canonical.employment_type,
  version.description_text AS description,
  COALESCE(canonical.processing_state, canonical.processing_status) AS processing_state,
  canonical.recommendation_eligibility,
  canonical.recommendation_outcome,
  canonical.archived_at,
  canonical.archive_reason,
  canonical.archive_age_basis,
  canonical.archive_reference_at,
  source.source_name,
  active_hold.expires_at AS active_hold_until
FROM canonical_jobs canonical
LEFT JOIN job_versions version
  ON version.workspace_id = canonical.workspace_id
 AND version.canonical_job_id = canonical.id
 AND version.id = canonical.latest_job_version_id
LEFT JOIN LATERAL (
  SELECT observation.source_name
  FROM raw_job_observations observation
  WHERE observation.workspace_id = canonical.workspace_id
    AND observation.job_version_id = version.id
  ORDER BY observation.retrieved_at DESC, observation.id DESC
  LIMIT 1
) source ON TRUE
LEFT JOIN LATERAL (
  SELECT MAX(hold.expires_at) AS expires_at
  FROM job_archive_holds hold
  WHERE hold.workspace_id = canonical.workspace_id
    AND hold.canonical_job_id = canonical.id
    AND hold.released_at IS NULL
    AND hold.expires_at > NOW()
) active_hold ON TRUE
WHERE canonical.archived_at IS NOT NULL
  AND canonical.is_test_fixture = FALSE;

CREATE OR REPLACE VIEW v_job_archive_operational_status AS
SELECT
  last_success.completed_at AS last_success_at,
  latest.id AS latest_run_id,
  latest.status AS latest_run_status,
  latest.mode AS latest_run_mode,
  latest.run_started_at AS latest_run_started_at,
  latest.scanned_count AS latest_run_scanned_count,
  latest.eligible_count AS latest_run_eligible_count,
  latest.archived_count AS latest_run_archived_count,
  latest.protected_count AS latest_run_protected_count,
  latest.invalid_date_count AS latest_run_invalid_date_count,
  latest.failed_count AS latest_run_failed_count,
  latest.observed_age_publication_unknown_count AS latest_run_observed_age_publication_unknown_count
FROM (SELECT 1 AS singleton) anchor
LEFT JOIN LATERAL (
  SELECT run.completed_at
  FROM job_archive_runs run
  WHERE run.status = 'SUCCEEDED'
  ORDER BY run.completed_at DESC, run.id DESC
  LIMIT 1
) last_success ON TRUE
LEFT JOIN LATERAL (
  SELECT run.id, run.status, run.mode, run.run_started_at, run.scanned_count,
         run.eligible_count, run.archived_count, run.protected_count,
         run.invalid_date_count, run.failed_count,
         run.observed_age_publication_unknown_count
  FROM job_archive_runs run
  ORDER BY run.run_started_at DESC, run.id DESC
  LIMIT 1
) latest ON TRUE;

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
  AND canonical.archived_at IS NULL;

CREATE OR REPLACE VIEW v_rejected_jobs_audit_scoped AS
SELECT canonical.workspace_id, rejected.*
FROM canonical_jobs canonical
JOIN v_rejected_jobs_audit rejected ON rejected.id = canonical.id
WHERE canonical.is_test_fixture = FALSE
  AND canonical.archived_at IS NULL;

CREATE OR REPLACE VIEW v_pipeline_task_queue_health AS
WITH operational_tasks AS (
  SELECT task.*
  FROM pipeline_tasks task
  WHERE NOT EXISTS (
    SELECT 1
    FROM canonical_jobs canonical
    LEFT JOIN job_versions version
      ON version.workspace_id = canonical.workspace_id
     AND version.canonical_job_id = canonical.id
    WHERE canonical.workspace_id = task.workspace_id
      AND canonical.is_test_fixture = TRUE
      AND (task.payload->>'canonical_job_id' = canonical.id::text
        OR task.payload->>'job_version_id' = version.id::text)
  )
    AND (
      task.task_type = 'NORMALIZE_OBSERVATION'
      OR NOT EXISTS (
        SELECT 1
        FROM canonical_jobs archived_job
        LEFT JOIN job_versions archived_version
          ON archived_version.workspace_id = archived_job.workspace_id
         AND archived_version.canonical_job_id = archived_job.id
        WHERE archived_job.workspace_id = task.workspace_id
          AND archived_job.archived_at IS NOT NULL
          AND (task.payload->>'canonical_job_id' = archived_job.id::text
            OR task.payload->>'job_version_id' = archived_version.id::text
            OR EXISTS (
              SELECT 1
              FROM raw_job_observations archived_observation
              JOIN job_versions observation_version
                ON observation_version.workspace_id = archived_observation.workspace_id
               AND observation_version.id = archived_observation.job_version_id
              WHERE archived_observation.workspace_id = task.workspace_id
                AND archived_observation.id::text = task.payload->>'observation_id'
                AND observation_version.canonical_job_id = archived_job.id
            ))
      )
    )
)
SELECT
  workspace_id,
  task_type,
  status,
  COUNT(*)::int AS task_count,
  MIN(created_at) AS oldest_created_at,
  EXTRACT(EPOCH FROM NOW() - MIN(created_at))::bigint AS oldest_age_seconds
FROM operational_tasks
GROUP BY workspace_id, task_type, status;

COMMENT ON VIEW v_canonical_shortlist_scoped IS
  'Active canonical shortlist only; archived jobs remain available through v_archived_jobs_scoped and application history.';
COMMENT ON VIEW v_archived_jobs_scoped IS
  'Workspace-scoped archived vacancy list; archive state is independent of application history and recommendation state.';
COMMENT ON VIEW v_pipeline_task_queue_health IS
  'Operational task queue counts exclude jobs marked archived while preserving normalization work that may prove a genuine repost.';
