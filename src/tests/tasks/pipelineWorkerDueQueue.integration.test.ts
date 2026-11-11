import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { enforcePipelineWorkerExitPolicy } from "../../tasks/pipelineWorkerExitPolicy.js";
import { recordPipelineWorkerProgressSnapshot } from "../../tasks/pipelineWorkerProgress.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import {
  readLatestScheduledPendingAvailableAt,
  readOldestPendingTask,
  readQueueHealth,
} from "../../../scripts/process_pipeline_tasks.js";
import { readScopedTaskHealth } from "../../../scripts/run_scoped_pilot.js";
import { TASK_HEALTH_SQL, summarizeTaskStages } from "../../../scripts/report_pipeline_status.js";

// Exercises the SQL the worker, the scoped pilot and the status report ship, not copies of it.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run pipeline worker due-queue integration tests against its PostgreSQL service.");
}

const TASK_TYPE = "FETCH_JOB_CONTENT";
const HOUR = 3_600;

let adminPool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
// Every connection of this pool resolves tables in the test schema, so pool-based readers see it.
let workerPool: pg.Pool | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function ready(): { client: pg.PoolClient; pool: pg.Pool; workspaceId: string } {
  if (!client || !workerPool || !context) throw new Error("The due-queue test database is not initialized.");
  return { client, pool: workerPool, workspaceId: context.workspaceId };
}

async function insertPendingTask(input: {
  taskType?: string;
  payload: Record<string, unknown>;
  createdAt: string;
  availableAt: string;
  status?: string;
}): Promise<string> {
  const { client: db, workspaceId } = ready();
  const taskType = input.taskType ?? TASK_TYPE;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, available_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, NOW() + $6::interval, NOW() + $7::interval, NOW())
     RETURNING id::text`,
    [workspaceId, taskType, `${taskType}:${randomUUID()}`, JSON.stringify(input.payload), input.status ?? "PENDING", input.availableAt, input.createdAt],
  );
  return rows[0].id;
}

function scopeFor(jobVersionId: string) {
  return { taskTypes: [TASK_TYPE], jobVersionIds: [jobVersionId] };
}

describe.skipIf(skipReal)("pipeline worker due-queue reads (PostgreSQL)", () => {
  beforeAll(async () => {
    adminPool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await adminPool.connect();
    schemaName = `due_queue_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    workerPool = new pg.Pool({ ...pgConnectionConfig(databaseUrl), options: `-c search_path=${schemaName},public` });
  }, 120_000);

  afterAll(async () => {
    await workerPool?.end();
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await adminPool?.end();
  });

  it("measures scoped and unscoped queue health from due time and ignores scheduled tasks", async () => {
    const { pool, workspaceId } = ready();
    const jobVersionId = randomUUID();
    const payload = { job_version_id: jobVersionId };
    const scheduledId = await insertPendingTask({ payload, createdAt: "-3 days", availableAt: "1 day" });
    const dueId = await insertPendingTask({ payload, createdAt: "-6 hours", availableAt: "-5 hours" });
    await insertPendingTask({ payload, createdAt: "-2 days", availableAt: "-1 minute" });
    // Outside the scoped job version: due for 10 hours.
    const outOfScopeId = await insertPendingTask({ payload: { job_version_id: randomUUID() }, createdAt: "-10 hours", availableAt: "-10 hours" });

    const scoped = await readQueueHealth(pool, workspaceId, scopeFor(jobVersionId));
    expect(scoped.pending).toBe(3);
    expect(scoped.duePending).toBe(2);
    expect(scoped.scheduledPending).toBe(1);
    expect(scoped.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(4.9 * HOUR);
    expect(scoped.oldestPendingAgeSeconds).toBeLessThanOrEqual(5.1 * HOUR);

    const unscoped = await readQueueHealth(pool, workspaceId);
    expect(unscoped.pending).toBe(4);
    expect(unscoped.duePending).toBe(3);
    expect(unscoped.scheduledPending).toBe(1);
    expect(unscoped.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(9.9 * HOUR);
    expect(unscoped.oldestPendingAgeSeconds).toBeLessThanOrEqual(10.1 * HOUR);

    const oldestScoped = await readOldestPendingTask(pool, workspaceId, [TASK_TYPE], scopeFor(jobVersionId));
    expect(oldestScoped?.id).toBe(dueId);
    expect(oldestScoped?.ageSeconds).toBeGreaterThanOrEqual(4.9 * HOUR);
    expect(oldestScoped?.ageSeconds).toBeLessThanOrEqual(5.1 * HOUR);
    const oldestUnscoped = await readOldestPendingTask(pool, workspaceId, [TASK_TYPE]);
    expect(oldestUnscoped?.id).toBe(outOfScopeId);
    expect([oldestScoped?.id, oldestUnscoped?.id]).not.toContain(scheduledId);

    const latestScheduled = await readLatestScheduledPendingAvailableAt(pool, workspaceId, [TASK_TYPE], scopeFor(jobVersionId));
    expect(latestScheduled).not.toBeNull();
    const untilDueSeconds = (Date.parse(latestScheduled!) - Date.now()) / 1000;
    expect(untilDueSeconds).toBeGreaterThan(23.9 * HOUR);
    expect(untilDueSeconds).toBeLessThan(24.1 * HOUR);
  });

  it("reports no due age, no oldest task and no stall for a scope holding only scheduled work", async () => {
    const { pool, workspaceId } = ready();
    const scheduledOnly = randomUUID();
    await insertPendingTask({ payload: { job_version_id: scheduledOnly }, createdAt: "-3 days", availableAt: "1 day" });
    await insertPendingTask({ payload: { job_version_id: scheduledOnly }, createdAt: "-1 day", availableAt: "2 hours" });

    const health = await readQueueHealth(pool, workspaceId, scopeFor(scheduledOnly));
    expect(health.pending).toBe(2);
    expect(health.duePending).toBe(0);
    expect(health.scheduledPending).toBe(2);
    expect(health.oldestPendingAgeSeconds).toBe(0);
    expect(await readOldestPendingTask(pool, workspaceId, [TASK_TYPE], scopeFor(scheduledOnly))).toBeNull();

    const policyInput = {
      claimedThisRun: 0, completedThisRun: 0, failedThisRun: 0, exitReason: "QUEUE_DRAINED" as const,
      deadLetteredThisRun: 0, actionableCurrentDeadLetterCount: 0, staleHistoricalDeadLetterCount: 0,
      retryWaitCount: 0, oldestRetryWaitAgeSeconds: 0, oldestActivePendingTaskType: null,
      oldestPendingTaskSameRuns: 0, pendingAgeTrendRuns: 3, failOnRetryWait: true,
      maxRetryWaitCount: 500, maxRetryWaitAgeSeconds: 21_600, maxPendingAgeSeconds: 7_200, noProgressPendingThreshold: 1,
    };
    // A run that claimed nothing because nothing was due has not stalled.
    expect(() => enforcePipelineWorkerExitPolicy({
      ...policyInput,
      activePendingCountBefore: health.pending,
      activePendingCount: health.pending,
      activeDuePendingCount: health.duePending,
      oldestActivePendingAgeSecondsBefore: health.oldestPendingAgeSeconds,
      oldestActivePendingAgeSeconds: health.oldestPendingAgeSeconds,
    })).not.toThrow();

    // Due work that nobody claimed still fails the run (invariant 7).
    const dueUnclaimed = randomUUID();
    await insertPendingTask({ payload: { job_version_id: dueUnclaimed }, createdAt: "-3 days", availableAt: "1 day" });
    await insertPendingTask({ payload: { job_version_id: dueUnclaimed }, createdAt: "-2 minutes", availableAt: "-1 minute" });
    const withDue = await readQueueHealth(pool, workspaceId, scopeFor(dueUnclaimed));
    expect(withDue.duePending).toBe(1);
    expect(() => enforcePipelineWorkerExitPolicy({
      ...policyInput,
      activePendingCountBefore: withDue.pending,
      activePendingCount: withDue.pending,
      activeDuePendingCount: withDue.duePending,
      oldestActivePendingAgeSecondsBefore: withDue.oldestPendingAgeSeconds,
      oldestActivePendingAgeSeconds: withDue.oldestPendingAgeSeconds,
    })).toThrow("No forward progress: 1 due PENDING task(s) remain claimable after the worker run. 1 more are scheduled for later.");
  });

  it("never tracks a scheduled task as the oldest pending task across runs", async () => {
    const { client: db, pool, workspaceId } = ready();
    const jobVersionId = randomUUID();
    const scheduledId = await insertPendingTask({ payload: { job_version_id: jobVersionId }, createdAt: "-10 days", availableAt: "1 day" });
    const dueId = await insertPendingTask({ payload: { job_version_id: jobVersionId }, createdAt: "-1 hour", availableAt: "-1 hour" });

    const streaks: number[] = [];
    for (let run = 1; run <= 3; run += 1) {
      const oldest = await readOldestPendingTask(pool, workspaceId, [TASK_TYPE], scopeFor(jobVersionId));
      const snapshot = await recordPipelineWorkerProgressSnapshot(db, {
        workspaceId,
        runKey: `due-queue-test:${randomUUID()}`,
        activePendingCount: 2,
        oldestPendingTaskId: oldest?.id ?? null,
        oldestPendingTaskType: oldest?.taskType ?? null,
        oldestPendingCreatedAt: oldest?.createdAt ?? null,
        oldestPendingAgeSeconds: oldest?.ageSeconds ?? 0,
      }, 3);
      streaks.push(snapshot.consecutiveOldestTaskRuns);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(streaks).toEqual([1, 2, 3]);
    const { rows } = await db.query<{ oldest_pending_task_id: string | null }>(
      `SELECT oldest_pending_task_id::text AS oldest_pending_task_id
       FROM pipeline_worker_progress_snapshots
       WHERE workspace_id = $1 AND run_key LIKE 'due-queue-test:%'`,
      [workspaceId],
    );
    expect(rows.map((row) => row.oldest_pending_task_id)).toEqual([dueId, dueId, dueId]);
    expect(rows.map((row) => row.oldest_pending_task_id)).not.toContain(scheduledId);
  });

  it("measures the scoped pilot's pending age from due time and retry age from entry into RETRY_WAIT", async () => {
    const { client: db, workspaceId } = ready();
    const jobVersionId = randomUUID();
    const payload = { job_version_id: jobVersionId };
    await insertPendingTask({ payload, createdAt: "-3 days", availableAt: "1 day" });
    const scheduledOnly = await readScopedTaskHealth(db, workspaceId, jobVersionId);
    expect(scheduledOnly.pending).toBe(1);
    expect(scheduledOnly.duePending).toBe(0);
    expect(scheduledOnly.oldestPendingAgeSeconds).toBe(0);

    await insertPendingTask({ payload, createdAt: "-2 days", availableAt: "-3 minutes" });
    // Created 17 days ago, entered RETRY_WAIT 2 minutes ago (updated_at = NOW()).
    await insertPendingTask({ payload, createdAt: "-17 days", availableAt: "5 minutes", status: "RETRY_WAIT" });
    await db.query(
      `UPDATE pipeline_tasks SET updated_at = NOW() - INTERVAL '2 minutes'
       WHERE workspace_id = $1 AND status = 'RETRY_WAIT' AND payload->>'job_version_id' = $2`,
      [workspaceId, jobVersionId],
    );
    const health = await readScopedTaskHealth(db, workspaceId, jobVersionId);
    expect(health.pending).toBe(2);
    expect(health.duePending).toBe(1);
    expect(health.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(170);
    expect(health.oldestPendingAgeSeconds).toBeLessThan(600);
    expect(health.retryWait).toBe(1);
    expect(health.oldestRetryWaitAgeSeconds).toBeGreaterThanOrEqual(110);
    expect(health.oldestRetryWaitAgeSeconds).toBeLessThan(600);
  });

  it("joins due age into the status report and keeps archived and fixture work out of it", async () => {
    const { client: db, workspaceId } = ready();
    // Scheduled-only embedding work: reported as scheduled, not aged.
    await insertPendingTask({ taskType: "PUBLISH_EMBEDDING", payload: {}, createdAt: "-3 days", availableAt: "1 day" });
    // Due routing work past the SLO: aged.
    await insertPendingTask({ taskType: "ROUTE_LANE", payload: {}, createdAt: "-3 days", availableAt: "-3 hours" });

    // Due matching work for an archived job and for a test-fixture job is excluded from every age.
    const { rows: archiveRun } = await db.query<{ id: string }>(
      `INSERT INTO job_archive_runs (run_started_at, cutoff_at, mode, status)
       VALUES (NOW(), NOW() - INTERVAL '90 days', 'APPLY', 'SUCCEEDED') RETURNING id::text AS id`,
    );
    for (const [archived, fixture] of [[true, false], [false, true]]) {
      const canonicalJobId = randomUUID();
      await db.query(
        `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url,
                                     processing_state, processing_status, is_test_fixture,
                                     archived_at, archive_reason, archive_age_basis, archive_reference_at, archive_run_id)
         VALUES ($1, $2, 'Due Queue Test', 'Excluded Role', $3, 'PREQUALIFIED', 'PREQUALIFIED', $4,
                 CASE WHEN $5::boolean THEN NOW() END,
                 CASE WHEN $5::boolean THEN 'due-queue test archive' END,
                 CASE WHEN $5::boolean THEN 'OBSERVED_AGE_PUBLICATION_UNKNOWN' END,
                 CASE WHEN $5::boolean THEN NOW() - INTERVAL '90 days' END,
                 CASE WHEN $5::boolean THEN $6::uuid END)`,
        [canonicalJobId, workspaceId, `https://example.test/due-queue/${canonicalJobId}`, fixture, archived, archiveRun[0].id],
      );
      await insertPendingTask({
        taskType: "MATCH_PROFILE_EVIDENCE",
        payload: { canonical_job_id: canonicalJobId },
        createdAt: "-5 days",
        availableAt: "-5 days",
      });
    }
    const { rows: excluded } = await db.query(
      `SELECT * FROM v_pipeline_task_due_age WHERE workspace_id = $1 AND task_type = 'MATCH_PROFILE_EVIDENCE'`,
      [workspaceId],
    );
    expect(excluded).toEqual([]);

    const { rows } = await db.query(TASK_HEALTH_SQL, [workspaceId]);
    const embeddingRow = rows.find((row) => row.task_type === "PUBLISH_EMBEDDING" && row.status === "PENDING");
    expect(embeddingRow).toMatchObject({ task_count: 1, oldest_due_age_seconds: null, due_task_count: null });

    const stages = summarizeTaskStages(rows);
    expect(stages.find((stage) => stage.stage === "EMBEDDINGS")).toMatchObject({
      status: "BACKLOG_HEALTHY",
      pending: 1,
      scheduled_pending: 1,
      oldest_age_seconds: 0,
    });
    const routing = stages.find((stage) => stage.stage === "LANE_ROUTING");
    expect(routing).toMatchObject({ status: "BACKLOG_AGED", pending: 1, scheduled_pending: 0 });
    expect(routing!.oldest_age_seconds).toBeGreaterThanOrEqual(2.9 * HOUR);
    expect(routing!.oldest_age_seconds).toBeLessThanOrEqual(3.1 * HOUR);
    expect(stages.find((stage) => stage.stage === "PROFILE_MATCH")).toMatchObject({ pending: 0, oldest_age_seconds: 0 });
  });

  it("excludes archived and fixture tasks from the latest scheduled time, as the views exclude them from scheduled_pending", async () => {
    const { client: db, pool, workspaceId } = ready();
    const taskType = "APPLY_HARD_GATES";
    await insertPendingTask({ taskType, payload: {}, createdAt: "-1 day", availableAt: "1 day" });

    const { rows: archiveRun } = await db.query<{ id: string }>(
      `INSERT INTO job_archive_runs (run_started_at, cutoff_at, mode, status)
       VALUES (NOW(), NOW() - INTERVAL '90 days', 'APPLY', 'SUCCEEDED') RETURNING id::text AS id`,
    );
    for (const [archived, fixture] of [[true, false], [false, true]]) {
      const canonicalJobId = randomUUID();
      await db.query(
        `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url,
                                     processing_state, processing_status, is_test_fixture,
                                     archived_at, archive_reason, archive_age_basis, archive_reference_at, archive_run_id)
         VALUES ($1, $2, 'Due Queue Test', 'Excluded Scheduled Role', $3, 'PREQUALIFIED', 'PREQUALIFIED', $4,
                 CASE WHEN $5::boolean THEN NOW() END,
                 CASE WHEN $5::boolean THEN 'due-queue test archive' END,
                 CASE WHEN $5::boolean THEN 'OBSERVED_AGE_PUBLICATION_UNKNOWN' END,
                 CASE WHEN $5::boolean THEN NOW() - INTERVAL '90 days' END,
                 CASE WHEN $5::boolean THEN $6::uuid END)`,
        [canonicalJobId, workspaceId, `https://example.test/due-queue/${canonicalJobId}`, fixture, archived, archiveRun[0].id],
      );
      // Scheduled much later than the operational task: it would win MAX(available_at) if not excluded.
      await insertPendingTask({ taskType, payload: { canonical_job_id: canonicalJobId }, createdAt: "-1 day", availableAt: "30 days" });
    }

    const health = await readQueueHealth(pool, workspaceId);
    const pendingRow = health.byType.find((row) => row.task_type === taskType && row.status === "PENDING");
    expect(Number(pendingRow?.task_count)).toBe(1);
    expect(pendingRow?.due_task_count ?? 0).toBe(0);

    const latestScheduled = await readLatestScheduledPendingAvailableAt(pool, workspaceId, [taskType]);
    expect(latestScheduled).not.toBeNull();
    const untilDueSeconds = (Date.parse(latestScheduled!) - Date.now()) / 1000;
    expect(untilDueSeconds).toBeGreaterThan(23.9 * HOUR);
    expect(untilDueSeconds).toBeLessThan(24.1 * HOUR);
  });
});
