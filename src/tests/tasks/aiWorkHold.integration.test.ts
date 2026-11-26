import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { describeAiWork } from "../../modules/evaluation/index.js";
import { readAiWorkSettings } from "../../platform/config/index.js";
import { enforcePipelineWorkerExitPolicy } from "../../tasks/pipelineWorkerExitPolicy.js";
import { runPipelineStageTaskWorker } from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { readScopedAiHold, readScopedTaskHealth } from "../../../scripts/run_scoped_pilot.js";

// Real PostgreSQL: what the worker, its exit policy and the scoped pilot do with work the owner's AI switch holds.
const databaseUrl = process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
let reportDir = "";

const db = () => client!;
const workspaceId = () => context!.workspaceId;

async function insertTask(input: {
  taskType: string;
  status: string;
  jobVersionId?: string;
  age?: string;
  availableIn?: string;
  leaseExpiresIn?: string;
}): Promise<string> {
  const age = input.age ?? "-3 days";
  const { rows } = await db().query<{ id: string }>(
    `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, available_at, created_at, updated_at,
                                 lease_id, lease_expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, NOW() + $6::interval, NOW() + $7::interval, NOW() + $7::interval,
             CASE WHEN $8::text IS NULL THEN NULL ELSE gen_random_uuid() END, NOW() + $8::interval)
     RETURNING id::text`,
    [workspaceId(), input.taskType, `${input.taskType}:${randomUUID()}`,
      JSON.stringify({ job_version_id: input.jobVersionId ?? randomUUID() }), input.status,
      input.availableIn ?? age, age, input.leaseExpiresIn ?? null],
  );
  return rows[0]!.id;
}

const taskRow = async (id: string) => (await db().query(
  `SELECT status, attempt_count, lease_id::text, updated_at FROM pipeline_tasks WHERE id = $1`, [id],
)).rows[0];

describe.skipIf(skipReal)("held AI work in the worker and the scoped pilot (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `ai_hold_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-hold-"));
  }, 180_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db().query("DELETE FROM pipeline_task_attempts");
    await db().query("DELETE FROM pipeline_tasks");
  });

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
    if (reportDir) fs.rmSync(reportDir, { recursive: true, force: true });
  });

  // The shipped worker command, against this test's schema, with a held switch.
  async function runWorkerCommand(env: Record<string, string> = {}): Promise<void> {
    const url = new URL(databaseUrl);
    url.searchParams.set("options", `-c search_path=${schemaName},public`);
    const values: Record<string, string> = {
      DATABASE_URL: url.toString(),
      DATABASE_URL_UNPOOLED: url.toString(),
      AI_EVALUATION_ENABLED: "",
      AI_EVALUATION_SCORE_CUTOFF: "",
      AI_EVALUATION_SCORE_POLICY: "",
      PIPELINE_TASK_WORKER_TASK_TYPES: "DECIDE_RECOMMENDATION,ENQUEUE_EXPLANATION",
      PIPELINE_TASK_WORKER_SEED: "false",
      PIPELINE_TASK_WORKER_MAX_RETRY_WAIT_COUNT: "1",
      PIPELINE_TASK_WORKER_DEAD_LETTER_REPORT_FILE: path.join(reportDir, "dead-letter.json"),
      PIPELINE_TASK_WORKER_RECONCILIATION_REPORT_FILE: path.join(reportDir, "reconciliation.json"),
      GITHUB_OUTPUT: "",
      ...env,
    };
    for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
    // The command's pool is built when its module loads and closed when it ends: load a fresh one each time.
    vi.resetModules();
    const { processPipelineTasks } = await import("../../../scripts/process_pipeline_tasks.js");
    const exitCode = process.exitCode;
    try {
      await processPipelineTasks();
    } finally {
      process.exitCode = exitCode;
    }
  }

  it("keeps held pending and retry tasks out of the worker's SLOs, and nothing else", async () => {
    await insertTask({ taskType: "ENQUEUE_EXPLANATION", status: "PENDING" });
    await insertTask({ taskType: "ENQUEUE_EXPLANATION", status: "RETRY_WAIT", availableIn: "1 day" });
    await insertTask({ taskType: "ENQUEUE_EXPLANATION", status: "RETRY_WAIT", availableIn: "1 day" });
    await expect(runWorkerCommand()).resolves.toBeUndefined();

    // Retry work of another stage still counts, by age and by number.
    await insertTask({ taskType: "DECIDE_RECOMMENDATION", status: "RETRY_WAIT", availableIn: "1 day" });
    await expect(runWorkerCommand()).rejects.toThrow(/RETRY_BACKLOG_AGE/);
    await insertTask({ taskType: "DECIDE_RECOMMENDATION", status: "RETRY_WAIT", availableIn: "1 day", age: "-1 minute" });
    await expect(runWorkerCommand({ PIPELINE_TASK_WORKER_MAX_RETRY_WAIT_AGE_SECONDS: "604800" }))
      .rejects.toThrow(/RETRY_BACKLOG_COUNT.*2 > 1/);
  }, 120_000);

  it("fails the worker command on an unreadable switch value and leaves the held task untouched", async () => {
    const held = await insertTask({ taskType: "ENQUEUE_EXPLANATION", status: "PENDING" });
    const before = await taskRow(held);
    await expect(runWorkerCommand({ AI_EVALUATION_ENABLED: "true", AI_EVALUATION_SCORE_CUTOFF: "70" }))
      .rejects.toThrow(/AI_SCORE_CUTOFF_INVALID/);
    expect(await taskRow(held)).toEqual(before);
  }, 120_000);

  it("does not reclaim a held RUNNING task whose lease expired, and counts it as waiting", async () => {
    vi.stubEnv("AI_EVALUATION_ENABLED", "false");
    const expired = await insertTask({ taskType: "ENQUEUE_EXPLANATION", status: "RUNNING", leaseExpiresIn: "-1 hour" });
    const before = await taskRow(expired);
    const summary = await runPipelineStageTaskWorker(db(), {
      context: context!, taskTypes: ["ENQUEUE_EXPLANATION"], seed: false, maxTasks: 5, heartbeatSeconds: 0,
    });
    expect(summary).toMatchObject({ claimed: 0, failed: 0, deadLettered: 0 });
    expect(summary.aiWork).toMatchObject({
      mode: "HELD", waitingExplanationTasks: 1, expiredLeaseExplanationTasks: 1, queueRowsNotApproved: null,
    });
    expect(await taskRow(expired)).toEqual(before);

    await insertTask({ taskType: "ENQUEUE_EXPLANATION", status: "RUNNING", leaseExpiresIn: "1 hour" });
    expect(await describeAiWork(db(), workspaceId(), ["PRIORITY"], readAiWorkSettings()))
      .toMatchObject({ waitingExplanationTasks: 1, expiredLeaseExplanationTasks: 1 });
  }, 60_000);

  it("gives the scoped pilot no stall or age failure for a held task, and names the hold", async () => {
    const jobVersionId = randomUUID();
    await insertTask({ taskType: "ENQUEUE_EXPLANATION", status: "PENDING", jobVersionId });
    const exitPolicy = (health: Awaited<ReturnType<typeof readScopedTaskHealth>>) => () => enforcePipelineWorkerExitPolicy({
      claimedThisRun: 0, completedThisRun: 0, failedThisRun: 0, exitReason: "QUEUE_DRAINED",
      deadLetteredThisRun: 0, actionableCurrentDeadLetterCount: 0, staleHistoricalDeadLetterCount: 0,
      retryWaitCount: health.retryWait, oldestRetryWaitAgeSeconds: health.oldestRetryWaitAgeSeconds,
      activePendingCountBefore: health.pending, activePendingCount: health.pending,
      activeDuePendingCount: health.duePending,
      oldestActivePendingAgeSecondsBefore: health.oldestPendingAgeSeconds,
      oldestActivePendingAgeSeconds: health.oldestPendingAgeSeconds,
      failOnRetryWait: true, maxRetryWaitCount: 500, maxRetryWaitAgeSeconds: 21_600,
      maxPendingAgeSeconds: 7_200, noProgressPendingThreshold: 1,
    });

    vi.stubEnv("AI_EVALUATION_ENABLED", "false");
    const held = await readScopedTaskHealth(db(), workspaceId(), jobVersionId);
    expect(held).toMatchObject({ pending: 0, duePending: 0, oldestPendingAgeSeconds: 0 });
    expect(exitPolicy(held)).not.toThrow();
    expect(await readScopedAiHold(db(), workspaceId(), jobVersionId))
      .toEqual({ reason: "AI_EVALUATION_NOT_ENABLED", waitingExplanationTasks: 1 });

    // Open, the same task is ordinary backlog again; the job (no score here) is reported as not approved.
    vi.stubEnv("AI_EVALUATION_ENABLED", "true");
    vi.stubEnv("AI_EVALUATION_SCORE_CUTOFF", "0.5");
    vi.stubEnv("AI_EVALUATION_SCORE_POLICY", "m|r");
    const open = await readScopedTaskHealth(db(), workspaceId(), jobVersionId);
    expect(open).toMatchObject({ pending: 1, duePending: 1 });
    expect(exitPolicy(open)).toThrow(/PENDING_QUEUE_AGE/);
    expect(await readScopedAiHold(db(), workspaceId(), jobVersionId))
      .toEqual({ reason: "AI_JOB_NOT_APPROVED", waitingExplanationTasks: 1 });
  }, 60_000);
});
