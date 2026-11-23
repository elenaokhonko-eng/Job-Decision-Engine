/**
 * "Task completed, no result": a pipeline task is COMPLETED but the artifact that proves its work is
 * missing. A stage that ends without writing its result looks finished and hides the job from every
 * retry, so the reconciler reports it as an error (invariant 7: a broken funnel exits non-zero).
 *
 * Read only. Counts tasks that completed for real: tasks the system closed without running them
 * (repair_action set: archived job, reconciled as satisfied or superseded) are not errors, nor are
 * tasks for a job version that is no longer the current one or a job that is archived or a fixture.
 */
import type pg from "pg";

type Queryable = Pick<pg.PoolClient, "query">;

/** RECHECK_AVAILABILITY joins this list once migration 115 (job_availability_recheck_events) is on main.
 * Task type -> SQL predicate (alias task, version job_version_id) that is TRUE when the result exists. */
const RESULT_EXISTS_SQL: Readonly<Record<string, string>> = {
  APPLY_HARD_GATES: `EXISTS (SELECT 1 FROM gate_decisions result
                              WHERE result.workspace_id = task.workspace_id AND result.job_version_id::text = task.payload->>'job_version_id')`,
  ROUTE_LANE: `EXISTS (SELECT 1 FROM lane_decisions result
                        WHERE result.workspace_id = task.workspace_id AND result.job_version_id::text = task.payload->>'job_version_id')`,
  MATCH_PROFILE_EVIDENCE: `EXISTS (SELECT 1 FROM match_runs result
                                    WHERE result.workspace_id = task.workspace_id AND result.job_version_id::text = task.payload->>'job_version_id')`,
  DECIDE_RECOMMENDATION: `EXISTS (SELECT 1 FROM deterministic_decisions result
                                   WHERE result.workspace_id = task.workspace_id AND result.job_version_id::text = task.payload->>'job_version_id')`,
};

export const COMPLETED_RESULT_TASK_TYPES: readonly string[] = Object.keys(RESULT_EXISTS_SQL);

export interface CompletedWithoutResultRow {
  readonly taskId: string;
  readonly taskType: string;
  readonly jobVersionId: string;
  readonly completedAt: string | null;
}

export interface CompletedWithoutResultReport {
  readonly total: number;
  readonly byTaskType: Record<string, number>;
  /** First rows, oldest first; ids only, never job content. */
  readonly sample: readonly CompletedWithoutResultRow[];
}

export async function findTasksCompletedWithoutResult(
  client: Queryable,
  workspaceId: string,
  options: { sampleLimit?: number } = {},
): Promise<CompletedWithoutResultReport> {
  const sampleLimit = Math.max(0, Math.min(options.sampleLimit ?? 20, 200));
  const missing = Object.entries(RESULT_EXISTS_SQL)
    .map(([type, exists]) => `(task.task_type = '${type}' AND NOT ${exists})`)
    .join("\n          OR ");
  const { rows } = await client.query<{ task_id: string; task_type: string; job_version_id: string; completed_at: Date | null }>(
    `SELECT task.id::text AS task_id, task.task_type, task.payload->>'job_version_id' AS job_version_id, task.completed_at
       FROM pipeline_tasks task
       JOIN job_versions version
         ON version.workspace_id = task.workspace_id AND version.id::text = task.payload->>'job_version_id'
       JOIN canonical_jobs canonical
         ON canonical.workspace_id = version.workspace_id AND canonical.id = version.canonical_job_id
      WHERE task.workspace_id = $1::uuid
        AND task.status = 'COMPLETED'
        AND task.repair_action IS NULL
        AND task.task_type = ANY($2::text[])
        AND canonical.latest_job_version_id = version.id
        AND canonical.archived_at IS NULL
        AND canonical.is_test_fixture = FALSE
        AND COALESCE(canonical.processing_state, canonical.processing_status) <> 'MANUALLY_REMOVED'
        AND (${missing})
      ORDER BY task.completed_at ASC NULLS FIRST, task.id ASC`,
    [workspaceId, [...COMPLETED_RESULT_TASK_TYPES]],
  );
  const byTaskType: Record<string, number> = {};
  for (const row of rows) byTaskType[row.task_type] = (byTaskType[row.task_type] ?? 0) + 1;
  return {
    total: rows.length,
    byTaskType,
    sample: rows.slice(0, sampleLimit).map((row) => ({
      taskId: row.task_id,
      taskType: row.task_type,
      jobVersionId: row.job_version_id,
      completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    })),
  };
}
