import pg from "pg";

export const STALE_SUPERSEDED_EMBEDDING_REPAIR_ACTION =
  "RECONCILED_STALE_SUPERSEDED_JOB_VERSION" as const;

export type DeadLetterClassification = "ACTIONABLE_CURRENT" | "STALE_HISTORICAL";

export interface DeadLetterTaskHealth extends pg.QueryResultRow {
  task_type: string;
  actionable_dead_letter_count: number;
  stale_historical_dead_letter_count: number;
}

export const DEAD_LETTER_LINEAGE_JOINS_SQL = `
  LEFT JOIN canonical_jobs AS dead_letter_job
    ON dead_letter_job.workspace_id = task.workspace_id
   AND dead_letter_job.id::TEXT = task.payload->>'canonical_job_id'
  LEFT JOIN job_versions AS dead_letter_job_version
    ON dead_letter_job_version.workspace_id = task.workspace_id
   AND dead_letter_job_version.canonical_job_id = dead_letter_job.id
   AND dead_letter_job_version.id::TEXT = task.payload->>'job_version_id'
`;

export const DEAD_LETTER_CLASSIFICATION_SQL = `CASE
  WHEN task.task_type = 'PUBLISH_EMBEDDING'
   AND (
     POSITION('${STALE_SUPERSEDED_EMBEDDING_REPAIR_ACTION}' IN COALESCE(task.repair_action, '')) > 0
     OR (
       dead_letter_job.id IS NOT NULL
       AND dead_letter_job_version.id IS NOT NULL
       AND dead_letter_job.latest_job_version_id IS NOT NULL
       AND dead_letter_job_version.id <> dead_letter_job.latest_job_version_id
     )
   )
    THEN 'STALE_HISTORICAL'
  ELSE 'ACTIONABLE_CURRENT'
END`;

interface Queryable {
  query: pg.PoolClient["query"];
}

export async function reconcileStaleSupersededEmbeddingDeadLetters(
  client: Queryable,
  workspaceId: string,
): Promise<number> {
  const result = await client.query<{ id: string }>(
    `UPDATE pipeline_tasks AS task
     SET repair_action = CASE
           WHEN NULLIF(BTRIM(task.repair_action), '') IS NULL THEN $2
           WHEN POSITION($2 IN task.repair_action) > 0 THEN task.repair_action
           ELSE task.repair_action || E'\\n' || $2
         END,
         updated_at = NOW()
     FROM canonical_jobs AS dead_letter_job
     JOIN job_versions AS dead_letter_job_version
       ON dead_letter_job_version.workspace_id = dead_letter_job.workspace_id
      AND dead_letter_job_version.canonical_job_id = dead_letter_job.id
     WHERE task.workspace_id = $1
       AND task.task_type = 'PUBLISH_EMBEDDING'
       AND task.status = 'DEAD_LETTER'
       AND POSITION($2 IN COALESCE(task.repair_action, '')) = 0
       AND task.payload->>'canonical_job_id' = dead_letter_job.id::TEXT
       AND task.payload->>'job_version_id' = dead_letter_job_version.id::TEXT
       AND COALESCE(dead_letter_job.is_test_fixture, FALSE) = FALSE
       AND dead_letter_job.latest_job_version_id IS NOT NULL
       AND dead_letter_job_version.id <> dead_letter_job.latest_job_version_id
     RETURNING task.id`,
    [workspaceId, STALE_SUPERSEDED_EMBEDDING_REPAIR_ACTION],
  );
  return result.rowCount ?? result.rows.length;
}

export async function readDeadLetterTaskHealth(
  client: Queryable,
  workspaceId: string,
): Promise<DeadLetterTaskHealth[]> {
  const result = await client.query<DeadLetterTaskHealth>(
    `SELECT task.task_type,
            COUNT(*) FILTER (
              WHERE (${DEAD_LETTER_CLASSIFICATION_SQL}) = 'ACTIONABLE_CURRENT'
            )::INTEGER AS actionable_dead_letter_count,
            COUNT(*) FILTER (
              WHERE (${DEAD_LETTER_CLASSIFICATION_SQL}) = 'STALE_HISTORICAL'
            )::INTEGER AS stale_historical_dead_letter_count
     FROM pipeline_tasks AS task
     ${DEAD_LETTER_LINEAGE_JOINS_SQL}
     WHERE task.workspace_id = $1
       AND task.status = 'DEAD_LETTER'
       AND NOT EXISTS (
         SELECT 1
         FROM canonical_jobs AS fixture_job
         LEFT JOIN job_versions AS fixture_version
           ON fixture_version.workspace_id = fixture_job.workspace_id
          AND fixture_version.canonical_job_id = fixture_job.id
         WHERE fixture_job.workspace_id = task.workspace_id
           AND fixture_job.is_test_fixture = TRUE
           AND (
             task.payload->>'canonical_job_id' = fixture_job.id::TEXT
             OR task.payload->>'job_version_id' = fixture_version.id::TEXT
           )
       )
     GROUP BY task.task_type
     ORDER BY task.task_type`,
    [workspaceId],
  );
  return result.rows;
}
