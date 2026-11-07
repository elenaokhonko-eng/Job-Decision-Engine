import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { ModelRateLimitedError } from "../../services/modelCallResilience.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import {
  runPipelineStageTaskWorker,
  type PipelineStageWorkerDependencies,
} from "../../tasks/stageTaskWorker.js";
import { parsePipelineWorkerConcurrency } from "../../tasks/pipelineWorkerLanes.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { COMPLETE_TEST_POSTING_DESCRIPTION, insertCompletePostingEvidence } from "../fixtures/completePostingEvidence.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

let pool: pg.Pool | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function db(): pg.Pool {
  if (!pool) throw new Error("Concurrency test pool is not initialized.");
  return pool;
}

function workspace(): WorkspaceContext {
  if (!context) throw new Error("Concurrency test workspace is not initialized.");
  return context;
}

interface DecisionJob {
  canonicalJobId: string;
  jobVersionId: string;
  taskId: string;
}

/**
 * Creates jobs that are ROUTING_DEFERRED with complete posting content and one
 * pending DECIDE_RECOMMENDATION task each, so the real worker path (archive
 * guard, content gate, state lookups, completion, successor bookkeeping) runs
 * while the decider itself is a controllable test double.
 */
async function createDecisionJobs(
  count: number,
  taskType: "DECIDE_RECOMMENDATION" | "ENQUEUE_EXPLANATION" = "DECIDE_RECOMMENDATION",
): Promise<DecisionJob[]> {
  const jobs: DecisionJob[] = [];
  for (let index = 0; index < count; index += 1) {
    const canonical = await db().query<{ id: string }>(
      `INSERT INTO canonical_jobs (
         workspace_id, company_name, normalized_title, canonical_url, location_summary,
         workplace_type, employment_type, processing_state, processing_status
       ) VALUES ($1, $2, 'Concurrency Fixture Role', $3, 'Remote', 'REMOTE', 'FULL_TIME',
         'ROUTING_DEFERRED', 'ROUTING_DEFERRED')
       RETURNING id::text AS id`,
      [workspace().workspaceId, `Concurrency Fixture ${index}`, `https://concurrency.example.test/${crypto.randomUUID()}`],
    );
    const canonicalJobId = canonical.rows[0]?.id ?? "";
    const version = await db().query<{ id: string }>(
      `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at)
       VALUES ($1, $2, 1, $3, $4, NOW()) RETURNING id::text AS id`,
      [workspace().workspaceId, canonicalJobId, `concurrency-${crypto.randomUUID()}`, COMPLETE_TEST_POSTING_DESCRIPTION],
    );
    const jobVersionId = version.rows[0]?.id ?? "";
    await db().query(
      `UPDATE canonical_jobs SET latest_job_version_id = $3 WHERE workspace_id = $1 AND id = $2`,
      [workspace().workspaceId, canonicalJobId, jobVersionId],
    );
    await insertCompletePostingEvidence(db(), {
      workspaceId: workspace().workspaceId,
      jobVersionId,
      companyName: `Concurrency Fixture ${index}`,
      title: "Concurrency Fixture Role",
      sourceUrl: `https://concurrency.example.test/posting/${jobVersionId}`,
      description: COMPLETE_TEST_POSTING_DESCRIPTION,
    });
    const task = await enqueuePipelineTask({
      taskType,
      taskKey: `${taskType}:${jobVersionId}:concurrency`,
      payload: { canonical_job_id: canonicalJobId, job_version_id: jobVersionId },
      maxAttempts: 8,
    }, db(), { context: workspace() });
    jobs.push({ canonicalJobId, jobVersionId, taskId: task.taskId });
  }
  return jobs;
}

interface DeciderProbe {
  dependencies: PipelineStageWorkerDependencies;
  maxInFlight: () => number;
  calls: () => string[];
}

function deciderProbe(behaviour: (jobVersionId: string, client: pg.Pool | pg.PoolClient) => Promise<void> = async () => {}): DeciderProbe {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: string[] = [];
  const runRecommendationDecider = async (
    client: pg.Pool | pg.PoolClient,
    options: { jobVersionIds?: string[] },
  ) => {
    const jobVersionId = options.jobVersionIds?.[0] ?? "";
    calls.push(jobVersionId);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      // Hold the task long enough for other lanes to start theirs.
      await new Promise((resolve) => setTimeout(resolve, 40));
      await behaviour(jobVersionId, client);
      await client.query(
        `UPDATE canonical_jobs canonical SET recommendation_outcome = 'SKIP'
         FROM job_versions version
         WHERE version.workspace_id = canonical.workspace_id
           AND version.canonical_job_id = canonical.id
           AND version.id = $1::uuid`,
        [jobVersionId],
      );
      return { updated: 1, decisionsInserted: 0, errors: 0, policySnapshotId: "fixture", policySnapshotHash: "fixture" };
    } finally {
      inFlight -= 1;
    }
  };
  return {
    dependencies: { runRecommendationDecider } as unknown as PipelineStageWorkerDependencies,
    maxInFlight: () => maxInFlight,
    calls: () => [...calls],
  };
}

async function taskStates(taskIds: string[]): Promise<Map<string, { status: string; attempts: number; attemptRows: number }>> {
  const { rows } = await db().query<{ id: string; status: string; attempt_count: number; attempt_rows: number }>(
    `SELECT task.id::text AS id, task.status, task.attempt_count,
            (SELECT COUNT(*)::int FROM pipeline_task_attempts attempt WHERE attempt.task_id = task.id) AS attempt_rows
     FROM pipeline_tasks task
     WHERE task.id = ANY($1::uuid[])`,
    [taskIds],
  );
  return new Map(rows.map((row) => [row.id, { status: row.status, attempts: row.attempt_count, attemptRows: row.attempt_rows }]));
}

function workerOptions(overrides: Record<string, unknown> = {}) {
  return {
    context: workspace(),
    seed: false,
    reconcileStalePending: false,
    taskTypes: ["DECIDE_RECOMMENDATION" as const],
    heartbeatSeconds: 0,
    maxTasks: 100,
    ...overrides,
  };
}

describe("parsePipelineWorkerConcurrency", () => {
  it("defaults to one lane and rejects values it cannot honour", () => {
    expect(parsePipelineWorkerConcurrency(undefined)).toBe(1);
    expect(parsePipelineWorkerConcurrency("")).toBe(1);
    expect(parsePipelineWorkerConcurrency("8")).toBe(8);
    for (const invalid of ["0", "-1", "1.5", "17", "many"]) {
      expect(() => parsePipelineWorkerConcurrency(invalid)).toThrow(/PIPELINE_TASK_WORKER_CONCURRENCY/);
    }
  });
});

describe.skipIf(skipReal)("pipeline stage worker lanes (PostgreSQL)", () => {
  beforeAll(async () => {
    schemaName = `worker_lanes_${crypto.randomUUID().replaceAll("-", "")}`;
    const bootstrap = new pg.Pool(pgConnectionConfig(databaseUrl));
    const client = await bootstrap.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}, public`);
      await runMigrations(client);
    } finally {
      client.release();
      await bootstrap.end();
    }
    // Every lane connection must see the test schema.
    pool = new pg.Pool({ ...pgConnectionConfig(databaseUrl), max: 20, options: `-c search_path=${schemaName},public` });
    const contextClient = await db().connect();
    try {
      context = await resolveWorkspaceContext(contextClient);
    } finally {
      contextClient.release();
    }
  }, 120_000);

  beforeEach(async () => {
    // Each case starts from an empty decision queue.
    await db().query(
      `UPDATE pipeline_tasks SET status = 'COMPLETED', completed_at = NOW(), lease_id = NULL
       WHERE task_type IN ('DECIDE_RECOMMENDATION', 'ENQUEUE_EXPLANATION') AND status <> 'COMPLETED'`,
    );
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      await pool.end();
      pool = undefined;
    }
  });

  it("runs tasks in parallel lanes and never claims a task twice, even across two workers", async () => {
    const jobs = await createDecisionJobs(24);
    const probe = deciderProbe();

    const [first, second] = await Promise.all([
      runPipelineStageTaskWorker(db(), workerOptions({ concurrency: 4, claimedBy: "lanes-a" }), probe.dependencies),
      runPipelineStageTaskWorker(db(), workerOptions({ concurrency: 4, claimedBy: "lanes-b" }), probe.dependencies),
    ]);

    expect(first.claimed + second.claimed).toBe(24);
    expect(first.completed + second.completed).toBe(24);
    expect(first.failed + second.failed).toBe(0);
    expect(probe.maxInFlight()).toBeGreaterThan(1);
    expect(probe.maxInFlight()).toBeLessThanOrEqual(8);
    expect(new Set(probe.calls()).size).toBe(24);
    expect(probe.calls()).toHaveLength(24);

    const states = await taskStates(jobs.map((job) => job.taskId));
    for (const job of jobs) {
      expect(states.get(job.taskId)).toEqual({ status: "COMPLETED", attempts: 1, attemptRows: 1 });
    }
  }, 120_000);

  it("keeps one lane exactly sequential", async () => {
    await createDecisionJobs(5);
    const probe = deciderProbe();
    const summary = await runPipelineStageTaskWorker(db(), workerOptions({ concurrency: 1 }), probe.dependencies);
    expect(summary).toMatchObject({ claimed: 5, completed: 5, failed: 0, exitReason: "QUEUE_DRAINED" });
    expect(probe.maxInFlight()).toBe(1);
  }, 60_000);

  it("respects the global and per-stage task budgets across lanes", async () => {
    const jobs = await createDecisionJobs(20);
    const globalProbe = deciderProbe();
    const globalRun = await runPipelineStageTaskWorker(
      db(),
      workerOptions({ concurrency: 6, maxTasks: 7, claimBatchSize: 3 }),
      globalProbe.dependencies,
    );
    expect(globalRun).toMatchObject({ claimed: 7, completed: 7, exitReason: "MAX_TASKS_REACHED" });
    expect(globalProbe.calls()).toHaveLength(7);

    const stageProbe = deciderProbe();
    const stageRun = await runPipelineStageTaskWorker(
      db(),
      workerOptions({ concurrency: 6, maxTasksByType: { DECIDE_RECOMMENDATION: 5 } }),
      stageProbe.dependencies,
    );
    expect(stageRun).toMatchObject({ claimed: 5, completed: 5, exitReason: "STAGE_LIMIT_REACHED" });
    expect(stageProbe.calls()).toHaveLength(5);

    const states = [...(await taskStates(jobs.map((job) => job.taskId))).values()];
    expect(states.filter((state) => state.status === "COMPLETED")).toHaveLength(12);
    expect(states.filter((state) => state.status === "PENDING" && state.attempts === 0 && state.attemptRows === 0)).toHaveLength(8);
  }, 120_000);

  it("routes a failing task through retry without losing or repeating the other lanes' tasks", async () => {
    const jobs = await createDecisionJobs(12);
    const failing = jobs[5];
    const probe = deciderProbe(async (jobVersionId) => {
      if (jobVersionId === failing.jobVersionId) throw new Error("fixture decider failure");
    });

    const summary = await runPipelineStageTaskWorker(db(), workerOptions({ concurrency: 4 }), probe.dependencies);

    // The first retry is immediate by policy, so the failing task is retried
    // once in the same run and then waits for its 30 s backoff.
    expect(summary).toMatchObject({ claimed: 13, completed: 11, failed: 2, deadLettered: 0 });
    expect(summary.errors).toHaveLength(2);
    for (const error of summary.errors) {
      expect(error).toMatchObject({ taskType: "DECIDE_RECOMMENDATION", error: "fixture decider failure" });
    }
    const states = await taskStates(jobs.map((job) => job.taskId));
    expect(states.get(failing.taskId)).toEqual({ status: "RETRY_WAIT", attempts: 2, attemptRows: 2 });
    for (const job of jobs.filter((candidate) => candidate !== failing)) {
      expect(states.get(job.taskId)).toEqual({ status: "COMPLETED", attempts: 1, attemptRows: 1 });
    }
  }, 120_000);

  it("stops claiming, settles in-flight lanes and rejects on an unexpected worker error", async () => {
    const jobs = await createDecisionJobs(30);
    const poisoned = jobs[2];
    const probe = deciderProbe(async (jobVersionId, client) => {
      if (jobVersionId !== poisoned.jobVersionId) return;
      // Simulate a lease lost to another worker: failing the task then cannot
      // be recorded, which is an operational error, not a task failure.
      await client.query(
        `UPDATE pipeline_tasks SET lease_id = gen_random_uuid() WHERE id = $1::uuid`,
        [poisoned.taskId],
      );
      throw new Error("fixture failure after lease loss");
    });

    await expect(
      runPipelineStageTaskWorker(db(), workerOptions({ concurrency: 3 }), probe.dependencies),
    ).rejects.toThrow(/Lost lease while failing pipeline task/);

    const states = await taskStates(jobs.map((job) => job.taskId));
    const others = jobs.filter((job) => job !== poisoned).map((job) => states.get(job.taskId));
    // In-flight tasks of the other lanes finished normally; nothing else was left leased.
    expect(others.filter((state) => state?.status === "RUNNING")).toEqual([]);
    for (const state of others) {
      if (state?.status === "COMPLETED") expect(state).toEqual({ status: "COMPLETED", attempts: 1, attemptRows: 1 });
      else expect(state).toEqual({ status: "PENDING", attempts: 0, attemptRows: 0 });
    }
    // New claims stopped well before the queue was drained.
    expect(others.filter((state) => state?.status === "PENDING").length).toBeGreaterThan(10);
  }, 120_000);

  it("keeps shared-state stages to one task in flight while other lanes are free", async () => {
    const jobs = await createDecisionJobs(6, "ENQUEUE_EXPLANATION");
    let inFlight = 0;
    let maxInFlight = 0;
    const budgetRunIds = new Set<string>();
    const dependencies = {
      runExplanationQueueEnqueuer: async (_client: unknown, options: { budgetRunId?: string }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        budgetRunIds.add(options.budgetRunId ?? "");
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        return { enqueued: 0, deferred: 0, skipped: 0, errors: 0 };
      },
    } as unknown as PipelineStageWorkerDependencies;

    const summary = await runPipelineStageTaskWorker(
      db(),
      workerOptions({ concurrency: 4, taskTypes: ["ENQUEUE_EXPLANATION"] }),
      dependencies,
    );
    expect(summary).toMatchObject({ claimed: 6, completed: 6, failed: 0 });
    expect(maxInFlight).toBe(1);
    // All explanation tasks of one invocation still share one AI budget run.
    expect(budgetRunIds.size).toBe(1);
    const states = await taskStates(jobs.map((job) => job.taskId));
    for (const job of jobs) expect(states.get(job.taskId)).toEqual({ status: "COMPLETED", attempts: 1, attemptRows: 1 });
  }, 120_000);

  it("refuses more than one lane without a pool", async () => {
    const client = await db().connect();
    try {
      await expect(runPipelineStageTaskWorker(client, workerOptions({ concurrency: 2 }))).rejects.toThrow(/requires a pg.Pool/);
    } finally {
      client.release();
    }
  });
  it("defers rate-limited tasks in parallel lanes without consuming an attempt, while the rest complete once", async () => {
    const jobs = await createDecisionJobs(12);
    const limited = new Set(jobs.filter((_, index) => index % 3 === 0).map((job) => job.jobVersionId));
    const probe = deciderProbe(async (jobVersionId) => {
      if (limited.has(jobVersionId)) {
        throw new ModelRateLimitedError("Gemini rate limited (429 RESOURCE_EXHAUSTED)",
          { provider: "gemini", model: "fixture", retryAfterMs: null, attempts: 5 });
      }
    });

    const summary = await runPipelineStageTaskWorker(db(), workerOptions({ concurrency: 4, claimedBy: "lanes-429" }), probe.dependencies);

    expect(summary).toMatchObject({ claimed: 12, completed: 8, failed: 0, deadLettered: 0, rateLimitDeferred: 4 });
    expect(summary.errors).toEqual([]);
    expect(probe.maxInFlight()).toBeGreaterThan(1);
    // Nothing was claimed twice.
    expect(probe.calls()).toHaveLength(12);
    expect(new Set(probe.calls()).size).toBe(12);

    const states = await taskStates(jobs.map((job) => job.taskId));
    const { rows } = await db().query<{ id: string; max_attempts: number; available_at: Date; rate_limited: boolean | null }>(
      `SELECT task.id::text AS id, task.max_attempts, task.available_at,
              (SELECT (attempt.metadata->>'rate_limited')::boolean FROM pipeline_task_attempts attempt
               WHERE attempt.task_id = task.id AND attempt.attempt_number = 1) AS rate_limited
       FROM pipeline_tasks task WHERE task.id = ANY($1::uuid[])`,
      [jobs.map((job) => job.taskId)],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const job of jobs) {
      if (limited.has(job.jobVersionId)) {
        expect(states.get(job.taskId)).toEqual({ status: "RETRY_WAIT", attempts: 1, attemptRows: 1 });
        // The attempt is returned: 1 used of 9 instead of 1 of 8.
        expect(byId.get(job.taskId)).toMatchObject({ max_attempts: 9, rate_limited: true });
        expect(new Date(byId.get(job.taskId)!.available_at).getTime()).toBeGreaterThan(Date.now() + 25_000);
      } else {
        expect(states.get(job.taskId)).toEqual({ status: "COMPLETED", attempts: 1, attemptRows: 1 });
        expect(byId.get(job.taskId)).toMatchObject({ max_attempts: 8 });
      }
    }
    const processingErrors = await db().query(
      `SELECT 1 FROM canonical_jobs WHERE id = ANY($1::uuid[]) AND processing_state = 'PROCESSING_ERROR'`,
      [jobs.map((job) => job.canonicalJobId)],
    );
    expect(processingErrors.rowCount).toBe(0);
  }, 120_000);
});

