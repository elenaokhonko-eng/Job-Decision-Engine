import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { COMPLETE_TEST_POSTING_DESCRIPTION, insertCompletePostingEvidence } from "../fixtures/completePostingEvidence.js";
import type { RequirementExtractionSummary } from "../../pipeline/requirementsExtractor.js";
import { ModelRateLimitedError } from "../../services/modelCallResilience.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { PROVIDER_CALLS_SQL, summarizeProviderCallRows } from "../../../scripts/report_pipeline_status.js";
import { runPipelineStageTaskWorker, type PipelineStageWorkerDependencies } from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function db(): pg.PoolClient {
  if (!client) throw new Error("The rate-limit deferral test client is not initialized.");
  return client;
}

function extractionSummary(quotedRateLimited: number): RequirementExtractionSummary {
  return {
    discovered: 1, processed: 1, deterministicInserted: 0, quotedInserted: 0, quotedFailed: quotedRateLimited, errors: 0,
    metrics: {
      quotedAttempted: 1, quotedSucceeded: 0, quotedValidationFailures: 0, quotedProviderFailures: quotedRateLimited,
      quotedRateLimited, retryWaitTransitions: 0, quotedPassRate: 0, byProviderModel: {},
    },
    details: [],
  } as RequirementExtractionSummary;
}

async function insertJob(): Promise<{ canonicalJobId: string; jobVersionId: string }> {
  const canonicalJobId = crypto.randomUUID();
  const jobVersionId = crypto.randomUUID();
  const url = `https://example.test/rate-limit/${canonicalJobId}`;
  await db().query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status)
     VALUES ($1, $2, 'Rate Limit Co', 'Data Lead', $3, 'LANE_ROUTED', 'LANE_ROUTED')`,
    [canonicalJobId, context!.workspaceId, url],
  );
  await db().query(
    `INSERT INTO job_versions (id, workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at)
     VALUES ($1, $2, $3, 1, $4, $5, NOW())`,
    [jobVersionId, context!.workspaceId, canonicalJobId, `hash-${crypto.randomUUID()}`, COMPLETE_TEST_POSTING_DESCRIPTION],
  );
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [jobVersionId, canonicalJobId]);
  await insertCompletePostingEvidence(db(), {
    workspaceId: context!.workspaceId, jobVersionId, companyName: "Rate Limit Co", title: "Data Lead",
    sourceUrl: url, description: COMPLETE_TEST_POSTING_DESCRIPTION,
  });
  return { canonicalJobId, jobVersionId };
}

async function runWorker(runRequirementsExtraction: PipelineStageWorkerDependencies["runRequirementsExtraction"]) {
  return runPipelineStageTaskWorker(db(), {
    context: context!,
    seed: false,
    reconcileStalePending: false,
    taskTypes: ["EXTRACT_QUOTED_REQUIREMENTS"],
    maxTasks: 1,
    heartbeatSeconds: 0,
    minTimeToStartTaskMs: 0,
  }, { runRequirementsExtraction } as Partial<PipelineStageWorkerDependencies> as PipelineStageWorkerDependencies);
}

async function taskRow(taskId: string) {
  const { rows } = await db().query<{
    status: string; attempt_count: number; max_attempts: number; available_at: Date; last_error: string | null;
    dead_letter_reason: string | null;
  }>(`SELECT status, attempt_count, max_attempts, available_at, last_error, dead_letter_reason FROM pipeline_tasks WHERE id = $1`, [taskId]);
  return rows[0];
}

describe.skipIf(skipReal)("rate-limited model calls reschedule pipeline tasks (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `rate_limit_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    // Task context fingerprints need exactly one active profile version.
    const profile = await client.query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
       VALUES ($1, $2, 'Rate Limit Fixture') RETURNING id::text AS id`,
      [context.workspaceId, `rate-limit-${crypto.randomUUID()}`],
    );
    await client.query(
      `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at)
       VALUES ($1, $2, 1, '2.2.0', $3, 'ACTIVE', NOW())`,
      [context.workspaceId, profile.rows[0].id, `rate-limit-${crypto.randomUUID()}`],
    );
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
      client = undefined;
    }
    await pool?.end();
    pool = undefined;
  });

  it("defers a 429 to RETRY_WAIT without consuming an attempt, dead-lettering, or marking the job a processing error", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const job = await insertJob();
    // One allowed attempt: without the deferral rule the first 429 would dead-letter the task.
    const enqueued = await enqueuePipelineTask({
      taskType: "EXTRACT_QUOTED_REQUIREMENTS",
      taskKey: `EXTRACT_QUOTED_REQUIREMENTS:${job.jobVersionId}:rate_limit_fixture`,
      payload: { canonical_job_id: job.canonicalJobId, job_version_id: job.jobVersionId },
      maxAttempts: 1,
    }, db(), { context: context! });
    expect(enqueued.inserted).toBe(true);

    for (let round = 1; round <= 2; round++) {
      const before = Date.now();
      const summary = await runWorker(vi.fn(async () => extractionSummary(1)));
      expect(summary).toMatchObject({ claimed: 1, completed: 0, failed: 0, deadLettered: 0, rateLimitDeferred: 1 });
      expect(summary.errors).toEqual([]);
      const task = await taskRow(enqueued.taskId);
      expect(task).toMatchObject({ status: "RETRY_WAIT", attempt_count: round, max_attempts: 1 + round, dead_letter_reason: null });
      expect(task.last_error).toMatch(/^RATE_LIMITED: /);
      // Rescheduled at least 30 s out (plus jitter), never immediately.
      expect(new Date(task.available_at).getTime()).toBeGreaterThanOrEqual(before + 29_000);
      await db().query(`UPDATE pipeline_tasks SET available_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [enqueued.taskId]);
    }

    const attempts = await db().query<{ attempt_number: number; status: string; metadata: Record<string, unknown> | null }>(
      `SELECT attempt_number, status, metadata FROM pipeline_task_attempts WHERE task_id = $1 ORDER BY attempt_number`,
      [enqueued.taskId],
    );
    expect(attempts.rows.map((row) => [row.attempt_number, row.status, row.metadata?.rate_limited])).toEqual([
      [1, "FAILED", true],
      [2, "FAILED", true],
    ]);
    const canonical = await db().query<{ processing_state: string }>(`SELECT processing_state FROM canonical_jobs WHERE id = $1`, [job.canonicalJobId]);
    expect(canonical.rows[0].processing_state).toBe("LANE_ROUTED");

    // A rate-limited error thrown by the stage itself is deferred the same way.
    const thrown = await runWorker(vi.fn(async () => {
      throw new ModelRateLimitedError("Gemini rate limited (429)", { provider: "gemini", model: "m", retryAfterMs: 90_000, attempts: 5 });
    }));
    expect(thrown).toMatchObject({ failed: 0, deadLettered: 0, rateLimitDeferred: 1 });
    const afterThrown = await taskRow(enqueued.taskId);
    expect(afterThrown).toMatchObject({ status: "RETRY_WAIT", max_attempts: 4 });
    // The provider's 90 s RetryInfo is honoured (plus up to 30 s jitter).
    expect(new Date(afterThrown.available_at).getTime()).toBeGreaterThanOrEqual(Date.now() + 85_000);
    await db().query(`UPDATE pipeline_tasks SET available_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [enqueued.taskId]);

    // A real failure still counts: the one non-429 attempt the task was given is now used.
    const failed = await runWorker(vi.fn(async () => { throw new Error("quoted extractor bug"); }));
    expect(failed).toMatchObject({ failed: 1, deadLettered: 1, rateLimitDeferred: 0 });
    expect(await taskRow(enqueued.taskId)).toMatchObject({ status: "DEAD_LETTER", attempt_count: 4, max_attempts: 4 });
  });
  it("reports per-model calls, 429s, timeouts and retries for the run window and applies the 5% stop rule", async () => {
    const attempts = (list: Array<Record<string, unknown>>) => JSON.stringify({ provider_attempts: list });
    const insert = (metadata: string, ageMinutes: number) => db().query(
      `INSERT INTO model_route_invocations (workspace_id, purpose, provider, model, status, request_hash, response_metadata, created_at)
       VALUES ($1, 'EXTRACTION', 'gemini', 'gemini-3.1-flash-lite', 'COMPLETED', $2, $3::jsonb, NOW() - make_interval(mins => $4))`,
      [context!.workspaceId, crypto.randomUUID(), metadata, ageMinutes],
    );
    await insert(attempts([
      { provider: "gemini", model: "gemini-3.1-flash-lite", attempt: 1, status: "FAILED", httpStatus: 429, errorKind: "RATE_LIMITED" },
      { provider: "gemini", model: "gemini-3.1-flash-lite", attempt: 2, status: "COMPLETED" },
    ]), 5);
    await insert(attempts([
      { provider: "gemini", model: "gemini-3.1-flash-lite", attempt: 1, status: "FAILED", errorKind: "TIMEOUT" },
      { provider: "openai", model: "gpt-5.6-luna", attempt: 1, status: "COMPLETED" },
    ]), 10);
    // A legacy attempt without errorKind still counts its HTTP 429; an old run outside the window does not count.
    await insert(attempts([{ provider: "gemini", model: "gemini-3.1-flash-lite", attempt: 1, status: "FAILED", httpStatus: 429 }]), 20);
    await insert(attempts([{ provider: "gemini", model: "gemini-3.1-flash-lite", attempt: 1, status: "FAILED", httpStatus: 429 }]), 600);
    await insert(JSON.stringify({ provider_attempts: "not-an-array" }), 1);

    const { rows } = await db().query(PROVIDER_CALLS_SQL, [context!.workspaceId, 90]);
    const summary = summarizeProviderCallRows(rows);
    expect(summary.by_model).toEqual([
      expect.objectContaining({ provider: "gemini", model: "gemini-3.1-flash-lite", calls: 4, succeeded: 1, rate_limited: 2, timeouts: 1, retries: 1 }),
      expect.objectContaining({ provider: "openai", model: "gpt-5.6-luna", calls: 1, succeeded: 1, rate_limited: 0 }),
    ]);
    expect(summary).toMatchObject({ total_calls: 5, rate_limited: 2, rate_limited_share: 0.4, stop_rule_triggered: true });
    expect(summarizeProviderCallRows([]).stop_rule_triggered).toBe(false);
  });
});
