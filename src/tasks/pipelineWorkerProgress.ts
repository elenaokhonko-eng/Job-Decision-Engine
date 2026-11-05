export interface PipelineWorkerProgressSnapshotInput {
  workspaceId: string;
  runKey: string;
  activePendingCount: number;
  oldestPendingTaskId: string | null;
  oldestPendingTaskType: string | null;
  oldestPendingCreatedAt: string | null;
  oldestPendingAgeSeconds: number;
}

interface PipelineWorkerProgressHistoryRow {
  oldest_pending_task_id: string | null;
}

interface PipelineWorkerProgressQueryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: PipelineWorkerProgressHistoryRow[] }>;
}

export function countConsecutiveOldestTaskSnapshots(
  rowsNewestFirst: readonly PipelineWorkerProgressHistoryRow[],
  oldestPendingTaskId: string | null,
): number {
  if (!oldestPendingTaskId) return 0;
  let count = 0;
  for (const row of rowsNewestFirst) {
    if (row.oldest_pending_task_id !== oldestPendingTaskId) break;
    count += 1;
  }
  return count;
}

export async function recordPipelineWorkerProgressSnapshot(
  client: PipelineWorkerProgressQueryable,
  input: PipelineWorkerProgressSnapshotInput,
  historyRunCount: number,
): Promise<{ consecutiveOldestTaskRuns: number }> {
  const historyLimit = Math.max(1, Math.floor(historyRunCount));
  await client.query(
    `INSERT INTO pipeline_worker_progress_snapshots (
       workspace_id,
       run_key,
       active_pending_count,
       oldest_pending_task_id,
       oldest_pending_task_type,
       oldest_pending_created_at,
       oldest_pending_age_seconds
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_id, run_key)
       DO UPDATE SET
       completed_at = clock_timestamp(),
       active_pending_count = EXCLUDED.active_pending_count,
       oldest_pending_task_id = EXCLUDED.oldest_pending_task_id,
       oldest_pending_task_type = EXCLUDED.oldest_pending_task_type,
       oldest_pending_created_at = EXCLUDED.oldest_pending_created_at,
       oldest_pending_age_seconds = EXCLUDED.oldest_pending_age_seconds`,
    [
      input.workspaceId,
      input.runKey,
      Math.max(0, Math.floor(input.activePendingCount)),
      input.oldestPendingTaskId,
      input.oldestPendingTaskType,
      input.oldestPendingCreatedAt,
      Math.max(0, Math.floor(input.oldestPendingAgeSeconds)),
    ],
  );
  const { rows } = await client.query(
    `SELECT oldest_pending_task_id::text AS oldest_pending_task_id
     FROM pipeline_worker_progress_snapshots
     WHERE workspace_id = $1
     ORDER BY completed_at DESC, id DESC
     LIMIT $2`,
    [input.workspaceId, historyLimit],
  );
  const consecutiveOldestTaskRuns = countConsecutiveOldestTaskSnapshots(rows, input.oldestPendingTaskId);

  await client.query(
    `DELETE FROM pipeline_worker_progress_snapshots
     WHERE workspace_id = $1
       AND id IN (
         SELECT id
         FROM pipeline_worker_progress_snapshots
         WHERE workspace_id = $1
         ORDER BY completed_at DESC, id DESC
         OFFSET 30
       )`,
    [input.workspaceId],
  );

  return { consecutiveOldestTaskRuns };
}
