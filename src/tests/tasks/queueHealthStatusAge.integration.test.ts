import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { enforcePipelineWorkerExitPolicy } from "../../tasks/pipelineWorkerExitPolicy.js";
import { claimPipelineTasks } from "../../tasks/pipelineTasks.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { oldestDuePendingAgeSeconds, oldestStatusAgeSeconds } from "../../../scripts/process_pipeline_tasks.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run queue health status-age integration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

describe.skipIf(skipReal)("v_pipeline_task_status_age (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `queue_health_status_age_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("measures retry-wait age from entry into RETRY_WAIT, not from task creation", async () => {
    if (!client || !context) throw new Error("The queue health test database is not initialized.");
    // A task created 17 days ago that failed and entered RETRY_WAIT two minutes ago.
    await client.query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, available_at, attempt_count, created_at, updated_at)
       VALUES ($1, 'ENQUEUE_EXPLANATION', $2, '{}'::jsonb, 'RETRY_WAIT', NOW(), 1,
               NOW() - INTERVAL '17 days', NOW() - INTERVAL '2 minutes')`,
      [context.workspaceId, `ENQUEUE_EXPLANATION:${randomUUID()}`],
    );

    const { rows } = await client.query(
      `SELECT health.task_type, health.status, health.task_count, health.oldest_age_seconds,
              status_age.oldest_status_age_seconds
       FROM v_pipeline_task_queue_health AS health
       LEFT JOIN v_pipeline_task_status_age AS status_age USING (workspace_id, task_type, status)
       WHERE health.workspace_id = $1 AND health.status = 'RETRY_WAIT'`,
      [context.workspaceId],
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0].oldest_age_seconds)).toBeGreaterThan(16 * 86_400);
    const retryAge = oldestStatusAgeSeconds(rows, "RETRY_WAIT");
    expect(retryAge).toBeGreaterThanOrEqual(110);
    expect(retryAge).toBeLessThan(600);

    // With the 6-hour retry-age SLO, a fresh retry of an old task no longer fails the run.
    const policyInput = {
      claimedThisRun: 10, completedThisRun: 10, failedThisRun: 0, exitReason: "MAX_TASKS_REACHED" as const, deadLetteredThisRun: 0,
      actionableCurrentDeadLetterCount: 0, staleHistoricalDeadLetterCount: 0, retryWaitCount: 1,
      activePendingCountBefore: 10, activePendingCount: 5, oldestActivePendingAgeSecondsBefore: 0, oldestActivePendingAgeSeconds: 0,
      oldestActivePendingTaskType: null, oldestPendingTaskSameRuns: 0, pendingAgeTrendRuns: 3, failOnRetryWait: false,
      maxRetryWaitCount: 500, maxRetryWaitAgeSeconds: 21_600, maxPendingAgeSeconds: 7_200, noProgressPendingThreshold: 1,
    };
    expect(() => enforcePipelineWorkerExitPolicy({ ...policyInput, oldestRetryWaitAgeSeconds: retryAge })).not.toThrow();
    expect(() => enforcePipelineWorkerExitPolicy({ ...policyInput, oldestRetryWaitAgeSeconds: Number(rows[0].oldest_age_seconds) }))
      .toThrow(/Retry backlog age exceeded SLO/);
  });

  it("measures pending age only for due tasks, from when they became claimable", async () => {
    if (!client || !context) throw new Error("The queue health test database is not initialized.");
    const taskType = "FETCH_JOB_CONTENT";
    // Created 3 days ago and scheduled for tomorrow: deliberately deferred, not stalled.
    await client.query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, available_at, created_at, updated_at)
       VALUES ($1, $2, $3, '{}'::jsonb, 'PENDING', NOW() + INTERVAL '1 day', NOW() - INTERVAL '3 days', NOW())`,
      [context.workspaceId, taskType, `${taskType}:scheduled:${randomUUID()}`],
    );

    const readRows = async () => (await client!.query(
      `SELECT health.task_type, health.status, health.task_count, health.oldest_age_seconds,
              status_age.oldest_status_age_seconds, due_age.oldest_due_age_seconds
       FROM v_pipeline_task_queue_health AS health
       LEFT JOIN v_pipeline_task_status_age AS status_age USING (workspace_id, task_type, status)
       LEFT JOIN v_pipeline_task_due_age AS due_age USING (workspace_id, task_type, status)
       WHERE health.workspace_id = $1 AND health.task_type = $2 AND health.status = 'PENDING'`,
      [context!.workspaceId, taskType],
    )).rows;

    const scheduledOnly = await readRows();
    expect(scheduledOnly).toHaveLength(1);
    expect(Number(scheduledOnly[0].oldest_age_seconds)).toBeGreaterThan(2 * 86_400);
    expect(scheduledOnly[0].oldest_due_age_seconds).toBeNull();
    expect(oldestDuePendingAgeSeconds(scheduledOnly)).toBe(0);

    // Created 3 days ago, became due 3 minutes ago: ages from the moment it became claimable.
    await client.query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, available_at, created_at, updated_at)
       VALUES ($1, $2, $3, '{}'::jsonb, 'PENDING', NOW() - INTERVAL '3 minutes', NOW() - INTERVAL '3 days', NOW())`,
      [context.workspaceId, taskType, `${taskType}:released:${randomUUID()}`],
    );
    const withDue = await readRows();
    const dueAge = oldestDuePendingAgeSeconds(withDue);
    expect(dueAge).toBeGreaterThanOrEqual(170);
    expect(dueAge).toBeLessThan(600);

    const policyInput = {
      claimedThisRun: 10, completedThisRun: 10, failedThisRun: 0, exitReason: "MAX_TASKS_REACHED" as const, deadLetteredThisRun: 0,
      actionableCurrentDeadLetterCount: 0, staleHistoricalDeadLetterCount: 0, retryWaitCount: 0, oldestRetryWaitAgeSeconds: 0,
      activePendingCountBefore: 10, activePendingCount: 5, oldestActivePendingAgeSecondsBefore: dueAge,
      oldestActivePendingTaskType: taskType, oldestPendingTaskSameRuns: 3, pendingAgeTrendRuns: 3, failOnRetryWait: false,
      maxRetryWaitCount: 500, maxRetryWaitAgeSeconds: 21_600, maxPendingAgeSeconds: 7_200, noProgressPendingThreshold: 1,
    };
    expect(() => enforcePipelineWorkerExitPolicy({ ...policyInput, oldestActivePendingAgeSeconds: dueAge })).not.toThrow();

    // A due task that has waited past the SLO still fails the run.
    await client.query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, available_at, created_at, updated_at)
       VALUES ($1, $2, $3, '{}'::jsonb, 'PENDING', NOW() - INTERVAL '5 hours', NOW() - INTERVAL '3 days', NOW())`,
      [context.workspaceId, taskType, `${taskType}:stalled:${randomUUID()}`],
    );
    const stalledAge = oldestDuePendingAgeSeconds(await readRows());
    expect(stalledAge).toBeGreaterThan(4 * 3_600);
    expect(stalledAge).toBeLessThan(6 * 3_600);
    expect(() => enforcePipelineWorkerExitPolicy({
      ...policyInput,
      oldestActivePendingAgeSecondsBefore: stalledAge,
      oldestActivePendingAgeSeconds: stalledAge,
    })).toThrow(/Pending queue age exceeded SLO/);
  });

  it("claims a due retry before an older PENDING backlog of the same type", async () => {
    if (!client || !context) throw new Error("The queue health test database is not initialized.");
    const taskType = "DECIDE_RECOMMENDATION";
    // Three PENDING tasks due for weeks, then one retry that became due a minute ago.
    for (let index = 0; index < 3; index += 1) {
      await client.query(
        `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, available_at, created_at, updated_at)
         VALUES ($1, $2, $3, '{}'::jsonb, 'PENDING', NOW() - INTERVAL '20 days', NOW() - INTERVAL '20 days', NOW() - INTERVAL '20 days')`,
        [context.workspaceId, taskType, `${taskType}:backlog-${index}:${randomUUID()}`],
      );
    }
    const retryKey = `${taskType}:retry:${randomUUID()}`;
    await client.query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, available_at, attempt_count, created_at, updated_at)
       VALUES ($1, $2, $3, '{}'::jsonb, 'RETRY_WAIT', NOW() - INTERVAL '1 minute', 1, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 minute')`,
      [context.workspaceId, taskType, retryKey],
    );
    // A retry whose backoff has not elapsed is still not claimable.
    await client.query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, available_at, attempt_count, created_at, updated_at)
       VALUES ($1, $2, $3, '{}'::jsonb, 'RETRY_WAIT', NOW() + INTERVAL '1 hour', 1, NOW() - INTERVAL '1 hour', NOW())`,
      [context.workspaceId, taskType, `${taskType}:future-retry:${randomUUID()}`],
    );

    const first = await claimPipelineTasks({ taskType, limit: 1, claimedBy: "retry-priority-test" }, client, { context });
    expect(first.map((task) => task.taskKey)).toEqual([retryKey]);

    const rest = await claimPipelineTasks({ taskType, limit: 10, claimedBy: "retry-priority-test" }, client, { context });
    expect(rest).toHaveLength(3);
    expect(rest.every((task) => task.taskKey.includes(":backlog-"))).toBe(true);
  });
});
