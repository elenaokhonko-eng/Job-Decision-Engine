import crypto from "crypto";
import pg from "pg";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";

type QueryClient = {
  query: pg.PoolClient["query"];
};

export type PipelineTaskStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "RETRY_WAIT"
  | "BLOCKED_DEPENDENCY"
  | "DEAD_LETTER";

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
  context_fingerprint?: string | null;
  blocked_on?: string | null;
  blocked_reason?: string | null;
  repair_action?: string | null;
}

export interface EnqueuePipelineTaskInput {
  taskType: string;
  taskKey: string;
  payload: unknown;
  maxAttempts?: number;
  availableAt?: Date;
  contextFingerprint?: string;
}

export interface EnqueuePipelineTaskResult {
  taskId: string;
  inserted: boolean;
  reactivated?: boolean;
}

export interface ReplayDeadLetterPipelineTaskInput {
  taskId?: string;
  taskKey?: string;
  resetAttempts?: boolean;
  maxAttempts?: number;
}

export interface ReplayDeadLetterPipelineTaskResult {
  taskId: string;
  replayed: boolean;
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
    const contextFingerprint = input.contextFingerprint ?? "legacy_pipeline_context_v1";
    const maxAttempts = input.maxAttempts ?? 8;

    const inserted = await (client as QueryClient).query<{ id: string }>(
      `
        INSERT INTO pipeline_tasks (
          workspace_id,
          task_type,
          task_key,
          payload,
          context_fingerprint,
          status,
          available_at,
          max_attempts,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, 'PENDING', COALESCE($6::timestamptz, NOW()), $7, NOW(), NOW())
        ON CONFLICT (workspace_id, task_key, context_fingerprint)
        DO NOTHING
        RETURNING id
      `,
      [
        ctx.workspaceId,
        input.taskType,
        input.taskKey,
        input.payload as any,
        contextFingerprint,
        availableAt,
        maxAttempts,
      ]
    );

    if (inserted.rows.length > 0) {
      return { taskId: inserted.rows[0].id, inserted: true, reactivated: false };
    }

    const existing = await (client as QueryClient).query<{ id: string; status: PipelineTaskStatus }>(
      `
        SELECT id, status
        FROM pipeline_tasks
        WHERE workspace_id = $1
          AND task_key = $2
          AND context_fingerprint = $3
        LIMIT 1
      `,
      [ctx.workspaceId, input.taskKey, contextFingerprint]
    );
    if (existing.rows.length === 0) {
      throw new Error(`Failed to enqueue task (no insert and no existing row): ${input.taskKey}`);
    }
    if (existing.rows[0].status === "BLOCKED_DEPENDENCY") {
      const reactivated = await (client as QueryClient).query<{ id: string }>(
        `
          UPDATE pipeline_tasks
          SET status = 'PENDING',
              available_at = NOW(),
              lease_id = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              claimed_by = NULL,
              last_error = NULL,
              blocked_on = NULL,
              blocked_reason = NULL,
              repair_action = NULL,
              completed_at = NULL,
              updated_at = NOW()
          WHERE workspace_id = $1
            AND id = $2
            AND status = 'BLOCKED_DEPENDENCY'
          RETURNING id
        `,
        [ctx.workspaceId, existing.rows[0].id]
      );
      return {
        taskId: existing.rows[0].id,
        inserted: false,
        reactivated: reactivated.rows.length > 0,
      };
    }

    return { taskId: existing.rows[0].id, inserted: false, reactivated: false };
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as any).release();
    }
  }
}

export async function replayDeadLetterPipelineTask(
  input: ReplayDeadLetterPipelineTaskInput,
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<ReplayDeadLetterPipelineTaskResult> {
  if (!input.taskId && !input.taskKey) {
    throw new Error("Provide taskId or taskKey to replay a dead-letter pipeline task.");
  }

  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const maxAttempts = input.maxAttempts ? Math.max(1, Math.floor(input.maxAttempts)) : null;
    const { rows } = await (client as QueryClient).query<{ id: string }>(
      `
        UPDATE pipeline_tasks
        SET status = 'PENDING',
            available_at = NOW(),
            lease_id = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            claimed_by = NULL,
            attempt_count = CASE WHEN $4::boolean THEN 0 ELSE attempt_count END,
            max_attempts = COALESCE($5::int, max_attempts),
            last_error = NULL,
            dead_letter_reason = NULL,
            blocked_on = NULL,
            blocked_reason = NULL,
            repair_action = NULL,
            completed_at = NULL,
            updated_at = NOW()
        WHERE workspace_id = $1
          AND ($2::uuid IS NULL OR id = $2::uuid)
          AND ($3::text IS NULL OR task_key = $3)
          AND status = 'DEAD_LETTER'
        RETURNING id
      `,
      [
        ctx.workspaceId,
        input.taskId ?? null,
        input.taskKey ?? null,
        Boolean(input.resetAttempts),
        maxAttempts,
      ]
    );

    if (rows.length === 0) {
      return { taskId: input.taskId ?? input.taskKey ?? "", replayed: false };
    }

    return { taskId: rows[0].id, replayed: true };
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
              AND (
                (
                  status IN ('PENDING', 'RETRY_WAIT')
                  AND available_at <= NOW()
                )
                OR (
                  status = 'RUNNING'
                  AND lease_expires_at <= NOW()
                )
              )
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
              last_error = CASE
                WHEN t.status = 'RUNNING' THEN COALESCE(t.last_error, 'Previous task lease expired before completion; reclaiming.')
                ELSE t.last_error
              END,
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
  await completePipelineTaskAndRun(task, clientOrPool, options);
}

export async function completePipelineTaskAndRun(
  task: ClaimedPipelineTask,
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: {
    context?: WorkspaceContext;
    afterComplete?: (client: pg.PoolClient | pg.Pool) => Promise<void>;
  }
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

      const updatedTask = await (client as QueryClient).query<{ id: string }>(
        `
          UPDATE pipeline_tasks
          SET status = 'COMPLETED',
              lease_id = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              claimed_by = NULL,
              last_error = NULL,
              blocked_on = NULL,
              blocked_reason = NULL,
              repair_action = NULL,
              completed_at = NOW(),
              updated_at = NOW()
          WHERE workspace_id = $1
            AND id = $2
            AND status = 'RUNNING'
            AND lease_id = $3::uuid
          RETURNING id
        `,
        [ctx.workspaceId, task.taskId, task.leaseId]
      );
      if (updatedTask.rows.length === 0) {
        throw new Error(`Lost lease while completing pipeline task ${task.taskId}.`);
      }

      await options?.afterComplete?.(client);
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

export interface BlockPipelineTaskInput {
  blockedOn: string;
  reason: string;
  repairAction: string;
}

export async function blockPipelineTask(
  task: ClaimedPipelineTask,
  input: BlockPipelineTaskInput,
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
          SET status = 'BLOCKED',
              finished_at = NOW(),
              error_message = $4
          WHERE workspace_id = $1
            AND task_id = $2
            AND attempt_number = $3
        `,
        [ctx.workspaceId, task.taskId, task.attemptNumber, input.reason]
      );

      const updatedTask = await (client as QueryClient).query<{ id: string }>(
        `
          UPDATE pipeline_tasks
          SET status = 'BLOCKED_DEPENDENCY',
              available_at = NULL,
              lease_id = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              claimed_by = NULL,
              last_error = $4,
              blocked_on = $5,
              blocked_reason = $4,
              repair_action = $6,
              completed_at = NULL,
              updated_at = NOW()
          WHERE workspace_id = $1
            AND id = $2
            AND status = 'RUNNING'
            AND lease_id = $3::uuid
          RETURNING id
        `,
        [
          ctx.workspaceId,
          task.taskId,
          task.leaseId,
          input.reason,
          input.blockedOn,
          input.repairAction,
        ]
      );
      if (updatedTask.rows.length === 0) {
        throw new Error(`Lost lease while blocking pipeline task ${task.taskId}.`);
      }

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
      const updatedTask = await (client as QueryClient).query<{ id: string }>(
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
              blocked_on = NULL,
              blocked_reason = NULL,
              repair_action = NULL,
              completed_at = CASE WHEN $4 = 'DEAD_LETTER' THEN NOW() ELSE completed_at END,
              updated_at = NOW()
          WHERE workspace_id = $1
            AND id = $2
            AND status = 'RUNNING'
            AND lease_id = $3::uuid
          RETURNING id
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
      if (updatedTask.rows.length === 0) {
        throw new Error(`Lost lease while failing pipeline task ${task.taskId}.`);
      }

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

/** Release an unfinished lease after a worker cancellation without dead-lettering the task. */
export async function releasePipelineTaskForRetry(
  task: ClaimedPipelineTask,
  reason: string,
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<boolean> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    await client.query("BEGIN");
    try {
      const released = await client.query(
        `
          UPDATE pipeline_tasks
          SET status = 'RETRY_WAIT',
              available_at = NOW(),
              lease_id = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              claimed_by = NULL,
              last_error = $4,
              updated_at = NOW()
          WHERE workspace_id = $1
            AND id = $2::uuid
            AND status = 'RUNNING'
            AND lease_id = $3::uuid
          RETURNING id
        `,
        [ctx.workspaceId, task.taskId, task.leaseId, reason]
      );

      if (released.rows.length > 0) {
        await client.query(
          `
            UPDATE pipeline_task_attempts
            SET status = 'FAILED',
                finished_at = NOW(),
                error_message = $3,
                metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('cancelled', true)
            WHERE workspace_id = $1
              AND task_id = $2::uuid
              AND attempt_number = $4
              AND status = 'STARTED'
          `,
          [ctx.workspaceId, task.taskId, reason, task.attemptNumber]
        );
      }

      await client.query("COMMIT");
      return released.rows.length > 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as pg.PoolClient).release();
    }
  }
}
