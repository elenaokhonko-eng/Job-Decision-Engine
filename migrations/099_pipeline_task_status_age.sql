-- Migration 099: v_pipeline_task_status_age reports how long each status has been held.
--
-- v_pipeline_task_queue_health.oldest_age_seconds is measured from created_at, so a task created
-- weeks ago that entered RETRY_WAIT a minute ago counted as weeks old against the worker's
-- retry-age SLO (PIPELINE_TASK_WORKER_MAX_RETRY_WAIT_AGE_SECONDS) and failed every drain run.
-- This new view applies exactly the same operational exclusions as migration 097 and reports
-- oldest_status_age_seconds from updated_at, which is set whenever a task changes status,
-- including entry into RETRY_WAIT. It is a separate view so that replaying earlier migrations,
-- which recreate v_pipeline_task_queue_health with their own column lists, stays safe.
-- Rollback: DROP VIEW v_pipeline_task_status_age. The view holds no data.

CREATE OR REPLACE VIEW v_pipeline_task_status_age AS
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
  EXTRACT(EPOCH FROM NOW() - MIN(updated_at))::bigint AS oldest_status_age_seconds
FROM operational_tasks
GROUP BY workspace_id, task_type, status;

COMMENT ON VIEW v_pipeline_task_status_age IS
  'Seconds since the longest-held operational task entered its current status (updated_at); same exclusions as v_pipeline_task_queue_health.';
