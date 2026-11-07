-- Migration 097: keyed archive and fixture exclusion in v_pipeline_task_queue_health.
--
-- Migration 093 excluded archived and test-fixture jobs by comparing every task payload
-- against every archived/fixture job with `uuid::text = payload->>...` predicates. Those
-- comparisons cannot use an index, so the view cost grew with tasks x archived jobs and a
-- single worker health read could take minutes once the daily archive had grown.
--
-- This revision keeps the exact same columns and exclusion semantics, but resolves each task
-- target with primary-key lookups. A payload value only ever matched `uuid::text` when it was
-- a canonical lowercase UUID, so non-UUID values keep matching nothing.
-- Rollback: re-apply the v_pipeline_task_queue_health definition from migration 093. The view
-- holds no data; no rows are changed or removed.

CREATE OR REPLACE VIEW v_pipeline_task_queue_health AS
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
  COUNT(*)::int AS task_count,
  MIN(created_at) AS oldest_created_at,
  EXTRACT(EPOCH FROM NOW() - MIN(created_at))::bigint AS oldest_age_seconds
FROM operational_tasks
GROUP BY workspace_id, task_type, status;

COMMENT ON VIEW v_pipeline_task_queue_health IS
  'Operational task queue counts exclude jobs marked archived while preserving normalization work that may prove a genuine repost.';
