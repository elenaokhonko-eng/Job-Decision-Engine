import crypto from "crypto";
import pg from "pg";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";

type QueryClient = {
  query: pg.PoolClient["query"];
};

export type PipelineTaskStatus = "PENDING" | "RUNNING" | "COMPLETED" | "RETRY_WAIT" | "DEAD_LETTER";

export interface PipelineTaskRow {
  id: string;
  workspace_id: string;
  task_type: string;
  task_key: string;
  payload: unknown;
  status: PipelineTaskStatus;
  available_at: string;
  lease_id: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  claimed_by: string | null;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  dead_letter_reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface EnqueuePipelineTaskInput {
  taskType: string;
  taskKey: string;
  payload: unknown;
  maxAttempts?: number;
  availableAt?: Date;
}

export interface EnqueuePipelineTaskResult {
  taskId: string;
  inserted: boolean;
}

export async function enqueuePipelineTask(
  input: EnqueuePipelineTaskInput,
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<EnqueuePipelineTaskResult> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const availableAt = input.availableAt ? input.availableAt.toISOString() : null;
    const maxAttempts = input.maxAttempts ?? 8;

    const inserted = await (client as QueryClient).query<{ id: string }>(
      `
        INSERT INTO pipeline_tasks (
          workspace_id,
          task_type,
          task_key,
          payload,
          status,
          available_at,
          max_attempts,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, 'PENDING', COALESCE($5::timestamptz, NOW()), $6, NOW(), NOW())
        ON CONFLICT (workspace_id, task_key)
        DO NOTHING
        RETURNING id
      `,
      [ctx.workspaceId, input.taskType, input.taskKey, input.payload as any, availableAt, maxAttempts]
    );

    if (inserted.rows.length > 0) {
      return { taskId: inserted.rows[0].id, inserted: true };
    }

    const existing = await (client as QueryClient).query<{ id: string }>(
      `
        SELECT id
        FROM pipeline_tasks
        WHERE workspace_id = $1
          AND task_key = $2
        LIMIT 1
      `,
      [ctx.workspaceId, input.taskKey]
    );
    if (existing.rows.length === 0) {
      throw new Error(`Failed to enqueue task (no insert and no existing row): ${input.taskKey}`);
    }
    return { taskId: existing.rows[0].id, inserted: false };
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as any).release();
    }
  }
}

export interface ClaimPipelineTasksInput {
  taskType: string;
  limit?: number;
  leaseSeconds?: number;
  claimedBy?: string;
}

export interface ClaimedPipelineTask {
  taskId: string;
  taskKey: string;
  taskType: string;
  payload: unknown;
  leaseId: string;
  leaseExpiresAt: string;
  attemptNumber: number;
  maxAttempts: number;
}

export async function claimPipelineTasks(
  input: ClaimPipelineTasksInput,
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<ClaimedPipelineTask[]> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  const limit = input.limit ?? 25;
  const leaseSeconds = input.leaseSeconds ?? 120;
  const claimedBy = input.claimedBy ?? `worker:${process.pid}`;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    await client.query("BEGIN");
    try {
      const { rows } = await (client as QueryClient).query<PipelineTaskRow>(
        `
          WITH claimable AS (
            SELECT id
            FROM pipeline_tasks
            WHERE workspace_id = $1
              AND task_type = $2
              AND status IN ('PENDING', 'RETRY_WAIT')
              AND available_at <= NOW()
              AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
            ORDER BY available_at ASC, created_at ASC
            LIMIT $3
            FOR UPDATE SKIP LOCKED
          )
          UPDATE pipeline_tasks t
          SET status = 'RUNNING',
              lease_id = gen_random_uuid(),
              lease_expires_at = NOW() + make_interval(secs => $4::int),
              heartbeat_at = NOW(),
              claimed_by = $5,
              attempt_count = attempt_count + 1,
              updated_at = NOW()
          FROM claimable
          WHERE t.id = claimable.id
          RETURNING t.*
        `,
        [ctx.workspaceId, input.taskType, limit, leaseSeconds, claimedBy]
      );

      for (const row of rows) {
        await (client as QueryClient).query(
          `
            INSERT INTO pipeline_task_attempts (
              workspace_id,
              task_id,
              attempt_number,
              status,
              started_at
            )
            VALUES ($1, $2, $3, 'STARTED', NOW())
            ON CONFLICT (task_id, attempt_number)
            DO NOTHING
          `,
          [ctx.workspaceId, row.id, row.attempt_count]
        );
      }

      await client.query("COMMIT");

      return rows.map((row) => ({
        taskId: row.id,
        taskKey: row.task_key,
        taskType: row.task_type,
        payload: row.payload,
        leaseId: row.lease_id || crypto.randomUUID(),
        leaseExpiresAt: row.lease_expires_at || new Date(Date.now() + leaseSeconds * 1000).toISOString(),
        attemptNumber: row.attempt_count,
        maxAttempts: row.max_attempts,
      }));
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as any).release();
    }
  }
}

export async function heartbeatPipelineTask(
  taskId: string,
  leaseId: string,
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext; extendLeaseSeconds?: number }
): Promise<boolean> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const extendSeconds = options?.extendLeaseSeconds ?? 120;

    const res = await (client as QueryClient).query(
      `
        UPDATE pipeline_tasks
        SET heartbeat_at = NOW(),
            lease_expires_at = NOW() + make_interval(secs => $4::int),
            updated_at = NOW()
        WHERE workspace_id = $1
          AND id = $2
          AND status = 'RUNNING'
          AND lease_id = $3::uuid
      `,
      [ctx.workspaceId, taskId, leaseId, extendSeconds]
    );

    return (res.rowCount ?? 0) > 0;
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as any).release();
    }
  }
}

export async function completePipelineTask(
  task: ClaimedPipelineTask,
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<void> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    await client.query("BEGIN");
    try {
      await (client as QueryClient).query(
        `
          UPDATE pipeline_task_attempts
          SET status = 'COMPLETED',
              finished_at = NOW()
          WHERE workspace_id = $1
            AND task_id = $2
            AND attempt_number = $3
        `,
        [ctx.workspaceId, task.taskId, task.attemptNumber]
      );

      await (client as QueryClient).query(
        `
          UPDATE pipeline_tasks
          SET status = 'COMPLETED',
              lease_id = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              claimed_by = NULL,
              last_error = NULL,
              completed_at = NOW(),
              updated_at = NOW()
          WHERE workspace_id = $1
            AND id = $2
            AND status = 'RUNNING'
            AND lease_id = $3::uuid
        `,
        [ctx.workspaceId, task.taskId, task.leaseId]
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as any).release();
    }
  }
}

export async function failPipelineTask(
  task: ClaimedPipelineTask,
  errorMessage: string,
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<void> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  const delaySeconds = Math.min(3600, 30 * Math.pow(2, Math.max(0, task.attemptNumber - 1)));
  const availableAt = new Date(Date.now() + delaySeconds * 1000).toISOString();

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    await client.query("BEGIN");
    try {
      await (client as QueryClient).query(
        `
          UPDATE pipeline_task_attempts
          SET status = 'FAILED',
              finished_at = NOW(),
              error_message = $4
          WHERE workspace_id = $1
            AND task_id = $2
            AND attempt_number = $3
        `,
        [ctx.workspaceId, task.taskId, task.attemptNumber, errorMessage]
      );

      const deadLetter = task.attemptNumber >= task.maxAttempts;
      await (client as QueryClient).query(
        `
          UPDATE pipeline_tasks
          SET status = $4,
              available_at = COALESCE($5::timestamptz, available_at),
              lease_id = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              claimed_by = NULL,
              last_error = $6,
              dead_letter_reason = CASE WHEN $4 = 'DEAD_LETTER' THEN $6 ELSE dead_letter_reason END,
              completed_at = CASE WHEN $4 = 'DEAD_LETTER' THEN NOW() ELSE completed_at END,
              updated_at = NOW()
          WHERE workspace_id = $1
            AND id = $2
            AND status = 'RUNNING'
            AND lease_id = $3::uuid
        `,
        [
          ctx.workspaceId,
          task.taskId,
          task.leaseId,
          deadLetter ? "DEAD_LETTER" : "RETRY_WAIT",
          deadLetter ? null : availableAt,
          errorMessage,
        ]
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as any).release();
    }
  }
}

