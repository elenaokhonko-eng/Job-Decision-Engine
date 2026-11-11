-- Migration 107: v_pipeline_task_due_age reports how long due PENDING work has waited.
--
-- v_pipeline_task_queue_health.oldest_age_seconds is measured from created_at over every PENDING
-- task, including tasks deliberately scheduled for later (available_at in the future). A task
-- created days ago and scheduled for tomorrow therefore counted as days old against the worker's
-- pending-age SLO (PIPELINE_TASK_WORKER_MAX_PENDING_AGE_SECONDS) and failed every drain run,
-- although nothing could claim it yet. This view applies exactly the same operational exclusions
-- as migrations 097 and 099, counts only PENDING tasks whose available_at has passed, and reports
-- oldest_due_age_seconds from GREATEST(created_at, available_at): the moment the task became
-- claimable. A due task that the worker never claims still ages and still fails the SLO.
-- It is a separate view, like v_pipeline_task_status_age, so replaying earlier migrations stays safe.
-- Rollback: DROP VIEW v_pipeline_task_due_age. The view holds no data.

CREATE OR REPLACE VIEW v_pipeline_task_due_age AS
WITH operational_tasks AS (
  SELECT task.*
  FROM pipeline_tasks task
  WHERE NOT (
    EXISTS (
      SELECT 1
      FROM canonical_jobs fixture_job
      WHERE fixture_job.workspace_id = task.workspace_id
        AND fixture_job.id = (CASE
          WHEN task.payload->>'canonical_job_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (task.payload->>'canonical_job_id')::uuid
        END)
        AND fixture_job.is_test_fixture = TRUE
    )
    OR EXISTS (
      SELECT 1
      FROM job_versions fixture_version
      JOIN canonical_jobs fixture_job
        ON fixture_job.workspace_id = fixture_version.workspace_id
       AND fixture_job.id = fixture_version.canonical_job_id
      WHERE fixture_version.workspace_id = task.workspace_id
        AND fixture_version.id = (CASE
          WHEN task.payload->>'job_version_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (task.payload->>'job_version_id')::uuid
        END)
        AND fixture_job.is_test_fixture = TRUE
    )
  )
    AND (
      task.task_type = 'NORMALIZE_OBSERVATION'
      OR NOT (
        EXISTS (
          SELECT 1
          FROM canonical_jobs archived_job
          WHERE archived_job.workspace_id = task.workspace_id
            AND archived_job.id = (CASE
              WHEN task.payload->>'canonical_job_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (task.payload->>'canonical_job_id')::uuid
            END)
            AND archived_job.archived_at IS NOT NULL
        )
        OR EXISTS (
          SELECT 1
          FROM job_versions archived_version
          JOIN canonical_jobs archived_job
            ON archived_job.workspace_id = archived_version.workspace_id
           AND archived_job.id = archived_version.canonical_job_id
          WHERE archived_version.workspace_id = task.workspace_id
            AND archived_version.id = (CASE
              WHEN task.payload->>'job_version_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (task.payload->>'job_version_id')::uuid
            END)
            AND archived_job.archived_at IS NOT NULL
        )
        OR EXISTS (
          SELECT 1
          FROM raw_job_observations archived_observation
          JOIN job_versions observation_version
            ON observation_version.workspace_id = archived_observation.workspace_id
           AND observation_version.id = archived_observation.job_version_id
          JOIN canonical_jobs archived_job
            ON archived_job.workspace_id = archived_observation.workspace_id
           AND archived_job.id = observation_version.canonical_job_id
          WHERE archived_observation.workspace_id = task.workspace_id
            AND archived_observation.id = (CASE
              WHEN task.payload->>'observation_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (task.payload->>'observation_id')::uuid
            END)
            AND archived_job.archived_at IS NOT NULL
        )
      )
    )
)
SELECT
  workspace_id,
  task_type,
  status,
  COUNT(*)::int AS due_task_count,
  EXTRACT(EPOCH FROM NOW() - MIN(GREATEST(created_at, available_at)))::bigint AS oldest_due_age_seconds
FROM operational_tasks
WHERE status = 'PENDING'
  AND available_at <= NOW()
GROUP BY workspace_id, task_type, status;

COMMENT ON VIEW v_pipeline_task_due_age IS
  'Seconds since the longest-waiting due PENDING task became claimable (GREATEST(created_at, available_at)); scheduled future work is excluded. Same exclusions as v_pipeline_task_queue_health.';
