/** Set-based reads and writes of `pipeline_tasks`: one round trip for a whole list of task identities. */
export interface PipelineTaskQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface PipelineTaskIdentityState {
  id: string;
  taskKey: string;
  contextFingerprint: string;
  status: string;
  repairAction: string | null;
  reassessmentReason: string | null;
}

export interface PendingPipelineTaskRow {
  taskType: string;
  taskKey: string;
  payload: unknown;
  contextFingerprint: string;
  maxAttempts: number;
  availableAt: string | null;
}

/** The stored tasks among these keys, whatever their status; the caller matches the context fingerprint. */
export async function selectPipelineTaskStates(
  db: PipelineTaskQueryable,
  workspaceId: string,
  taskKeys: readonly string[],
): Promise<PipelineTaskIdentityState[]> {
  const { rows } = await db.query(
    `SELECT id::text AS id, task_key, context_fingerprint, status, repair_action,
            payload->>'reassessment_reason' AS reassessment_reason
       FROM pipeline_tasks
      WHERE workspace_id = $1 AND task_key = ANY($2::text[])`,
    [workspaceId, [...taskKeys]],
  );
  return rows.map((row) => ({
    id: row.id,
    taskKey: row.task_key,
    contextFingerprint: row.context_fingerprint,
    status: row.status,
    repairAction: row.repair_action,
    reassessmentReason: row.reassessment_reason,
  }));
}

/**
 * Inserts PENDING tasks in one statement and returns how many were new (a concurrent insert of the same identity is
 * skipped). The timestamps are per row and follow the list order, so claiming keeps the caller's priority.
 */
export async function insertPendingPipelineTasks(
  db: PipelineTaskQueryable,
  workspaceId: string,
  tasks: readonly PendingPipelineTaskRow[],
): Promise<number> {
  if (tasks.length === 0) return 0;
  const { rows } = await db.query(
    `INSERT INTO pipeline_tasks (
       workspace_id, task_type, task_key, payload, context_fingerprint, status,
       available_at, max_attempts, created_at, updated_at
     )
     SELECT $1::uuid, task->>'taskType', task->>'taskKey', task->'payload', task->>'contextFingerprint', 'PENDING',
            COALESCE((task->>'availableAt')::timestamptz, clock_timestamp()), (task->>'maxAttempts')::int,
            clock_timestamp(), clock_timestamp()
       FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS input(task, position)
      ORDER BY input.position
     ON CONFLICT (workspace_id, task_key, context_fingerprint)
     DO NOTHING
     RETURNING id`,
    [workspaceId, JSON.stringify(tasks)],
  );
  return rows.length;
}
