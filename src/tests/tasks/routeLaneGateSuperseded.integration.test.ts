import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";

const { generateEmbeddingMock } = vi.hoisted(() => ({
  generateEmbeddingMock: vi.fn(async () => [1, 0, 0, 0]),
}));

vi.mock("../../services/agent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/agent.js")>();
  const { batchEmbeddingFromPerInput } = await import("../fixtures/embeddingBatchMock.js");
  return {
    ...actual,
    generateEmbeddingWithProviderAndModel: generateEmbeddingMock,
    generateEmbeddingsWithProviderAndModel: batchEmbeddingFromPerInput(generateEmbeddingMock as any),
  };
});

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { buildEmbeddingInputs } from "../../embeddings/inputBuilder.js";
import { runEmbeddingBatch } from "../../embeddings/batchCoordinator.js";
import { COMPLETE_TEST_POSTING_DESCRIPTION, insertCompletePostingEvidence } from "../fixtures/completePostingEvidence.js";
import { routableVerificationJobsStranded } from "../../tasks/integrityZeroChecks.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { runPipelineStageTaskWorker, type PipelineStageWorkerDependencies } from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the gate-superseded task integration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
let primarySpaceId = "";
const savedEmbeddingConfig: Record<string, string | undefined> = {};

function db(): pg.PoolClient {
  if (!client) throw new Error("The gate-superseded test client is not initialized.");
  return client;
}

async function insertJob(state: string): Promise<{ canonicalJobId: string; jobVersionId: string }> {
  const canonicalJobId = crypto.randomUUID();
  const jobVersionId = crypto.randomUUID();
  const url = `https://example.test/gate-superseded/${canonicalJobId}`;
  await db().query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status)
     VALUES ($1, $2, 'Gate Superseded Co', 'Fixture Role', $3, $4, $4)`,
    [canonicalJobId, context!.workspaceId, url, state],
  );
  await db().query(
    `INSERT INTO job_versions (id, workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at)
     VALUES ($1, $2, $3, 1, $4, $5, NOW())`,
    [jobVersionId, context!.workspaceId, canonicalJobId, `hash-${crypto.randomUUID()}`, COMPLETE_TEST_POSTING_DESCRIPTION],
  );
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [jobVersionId, canonicalJobId]);
  await insertCompletePostingEvidence(db(), {
    workspaceId: context!.workspaceId, jobVersionId, companyName: "Gate Superseded Co", title: "Fixture Role",
    sourceUrl: url, description: COMPLETE_TEST_POSTING_DESCRIPTION,
  });
  return { canonicalJobId, jobVersionId };
}

/** The gate-version refresh moves the job to a new deterministic outcome after the task was queued. */
async function applyGateOutcome(canonicalJobId: string, state: "HARD_REJECTED" | "NEEDS_VERIFICATION", decision: string, codes: string | null = null): Promise<void> {
  await db().query(
    `UPDATE canonical_jobs SET processing_state = $2, processing_status = $2, gate_decision = $3, rejection_reason = $4 WHERE id = $1`,
    [canonicalJobId, state, decision, codes],
  );
}

async function enqueueRouteRepair(job: { canonicalJobId: string; jobVersionId: string }, maxAttempts?: number): Promise<string> {
  const enqueued = await enqueuePipelineTask({
    taskType: "ROUTE_LANE",
    taskKey: `ROUTE_LANE:${job.jobVersionId}:lane_router_v1:repair`,
    payload: {
      canonical_job_id: job.canonicalJobId,
      job_version_id: job.jobVersionId,
      repair_dependency: "REQUIREMENT_EMBEDDING_MISSING",
      repair_generation: "semantic_match_repair_v2",
      reprocess_existing_state: true,
    },
    ...(maxAttempts ? { maxAttempts } : {}),
  }, db(), { context: context! });
  return enqueued.taskId;
}

async function taskRow(taskId: string) {
  return (await db().query<{ status: string; repair_action: string | null; last_error: string | null; dead_letter_reason: string | null }>(
    `SELECT status, repair_action, last_error, dead_letter_reason FROM pipeline_tasks WHERE id = $1`, [taskId])).rows[0]!;
}

async function jobRow(canonicalJobId: string) {
  return (await db().query<{ processing_state: string; gate_decision: string | null }>(
    `SELECT processing_state, gate_decision FROM canonical_jobs WHERE id = $1`, [canonicalJobId])).rows[0]!;
}

function runWorker(taskType: "ROUTE_LANE" | "PUBLISH_EMBEDDING" | "MATCH_PROFILE_EVIDENCE", dependencies: Partial<PipelineStageWorkerDependencies>) {
  return runPipelineStageTaskWorker(db(), {
    context: context!, seed: false, reconcileStalePending: false, taskTypes: [taskType], maxTasks: 1, heartbeatSeconds: 0, minTimeToStartTaskMs: 0,
  }, dependencies as PipelineStageWorkerDependencies);
}

async function publishJobVersionEmbedding(jobVersionId: string): Promise<void> {
  await buildEmbeddingInputs(db(), 100, {
    context: context!, includeRequirements: false, includeProfileFacts: false, includeLanePrototypes: false, includeJobVersions: true,
    jobVersionIds: [jobVersionId],
  });
  const inputs = await db().query<{ id: string }>(
    `SELECT id::text AS id FROM embedding_inputs ei
      WHERE ei.workspace_id = $1 AND ei.source_type = 'JOB_VERSION' AND ei.source_id = $2::uuid AND ei.is_current = TRUE
        AND NOT EXISTS (SELECT 1 FROM semantic_embeddings se WHERE se.embedding_input_id = ei.id AND se.embedding_space_id = $3)`,
    [context!.workspaceId, jobVersionId, primarySpaceId],
  );
  if (inputs.rows.length === 0) return;
  await runEmbeddingBatch(primarySpaceId, `gate-superseded-${crypto.randomUUID()}`, "PRIMARY", 100, inputs.rows.map((row) => row.id), undefined, undefined, db(), { context: context! });
}

function publishingDependencies(jobVersionId: string, afterPublish?: () => Promise<void>): Partial<PipelineStageWorkerDependencies> {
  return {
    runEmbeddingBatchWithFallback: vi.fn(async () => {
      await publishJobVersionEmbedding(jobVersionId);
      await afterPublish?.();
      return {
        seededSpaces: { primarySpaceId, fallbackSpaceId: primarySpaceId },
        inputBuild: { inserted: 0, fromRequirements: 0, fromProfileFacts: 0 },
        primary: { succeeded: 1, failed: 0, processed: 1, failedInputIds: [], rateLimited: 0 },
      } as never;
    }),
  };
}

async function enqueueEmbeddingJob(): Promise<{ canonicalJobId: string; jobVersionId: string }> {
  const job = await insertJob("PREQUALIFIED");
  await enqueuePipelineTask({
    taskType: "PUBLISH_EMBEDDING",
    taskKey: `PUBLISH_EMBEDDING:${job.jobVersionId}:repair`,
    payload: {
      canonical_job_id: job.canonicalJobId, job_version_id: job.jobVersionId,
      repair_dependency: "REQUIREMENT_EMBEDDING_MISSING", repair_generation: "semantic_match_repair_v2", reprocess_existing_state: true,
    },
  }, db(), { context: context! });
  return job;
}

async function taskRowByVersion(jobVersionId: string, taskType: string) {
  return (await db().query<{ status: string; repair_action: string | null }>(
    `SELECT status, repair_action FROM pipeline_tasks WHERE task_type = $2 AND payload->>'job_version_id' = $1 ORDER BY created_at DESC LIMIT 1`,
    [jobVersionId, taskType])).rows[0]!;
}

async function routeTaskCount(jobVersionId: string): Promise<number> {
  return Number((await db().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM pipeline_tasks WHERE task_type = 'ROUTE_LANE' AND payload->>'job_version_id' = $1`, [jobVersionId])).rows[0]!.n);
}

describe.skipIf(skipReal)("lane routing against a gate outcome that changed after the task was queued (PostgreSQL)", () => {
  beforeAll(async () => {
    for (const key of ["EMBEDDING_PRIMARY_PROVIDER", "EMBEDDING_PRIMARY_MODEL", "EMBEDDING_PRIMARY_DIMENSIONS"]) savedEmbeddingConfig[key] = process.env[key];
    process.env.EMBEDDING_PRIMARY_PROVIDER = "openai";
    process.env.EMBEDDING_PRIMARY_MODEL = "fixture-gate-superseded";
    process.env.EMBEDDING_PRIMARY_DIMENSIONS = "4";
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `gate_superseded_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    const profile = await client.query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
       VALUES ($1, $2, 'Gate Superseded Fixture') RETURNING id::text AS id`,
      [context.workspaceId, `gate-superseded-${crypto.randomUUID()}`],
    );
    await client.query(
      `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at)
       VALUES ($1, $2, 1, '2.2.0', $3, 'ACTIVE', NOW())`,
      [context.workspaceId, profile.rows[0]!.id, `gate-superseded-${crypto.randomUUID()}`],
    );
    const space = await client.query<{ id: string }>(
      `INSERT INTO embedding_spaces (workspace_id, space_key, provider, model, dimensions, normalization, distance_metric, is_fallback_space, active)
       VALUES ($1, $2, 'openai', 'fixture-gate-superseded', 4, 'L2', 'COSINE', FALSE, TRUE) RETURNING id::text AS id`,
      [context.workspaceId, `gate-superseded-${crypto.randomUUID()}`],
    );
    primarySpaceId = space.rows[0]!.id;
  }, 120_000);

  beforeEach(async () => {
    // Each test owns the queue: a task left by an earlier test must not be claimed by this test's single-task worker run.
    await db().query(`DELETE FROM pipeline_tasks`);
  });

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
      client = undefined;
    }
    await pool?.end();
    pool = undefined;
    for (const [key, value] of Object.entries(savedEmbeddingConfig)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([
    { state: "HARD_REJECTED" as const, decision: "HARD_REJECT" },
    { state: "NEEDS_VERIFICATION" as const, decision: "NEEDS_VERIFICATION" },
  ])("a queued ROUTE_LANE repair task completes as superseded when the gate moved the job to $state", async ({ state, decision }) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const job = await insertJob("PREQUALIFIED");
    const taskId = await enqueueRouteRepair(job);
    await applyGateOutcome(job.canonicalJobId, state, decision);
    const runLaneRouting = vi.fn(async () => ({ routed: 0, deferred: 0, skipped: 0, errors: 0 }));

    const summary = await runWorker("ROUTE_LANE", { runLaneRouting } as never);

    expect(summary).toMatchObject({ claimed: 1, completed: 1, failed: 0, deadLettered: 0 });
    expect(runLaneRouting).not.toHaveBeenCalled();
    expect(await taskRow(taskId)).toMatchObject({ status: "COMPLETED", repair_action: "SUPERSEDED_BY_GATE_OUTCOME", last_error: null, dead_letter_reason: null });
    expect(await jobRow(job.canonicalJobId)).toEqual({ processing_state: state, gate_decision: decision });
  });

  it("control: a routable job whose routing genuinely does not advance still fails and dead-letters", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const job = await insertJob("PREQUALIFIED");
    const taskId = await enqueueRouteRepair(job, 1);
    const runLaneRouting = vi.fn(async () => ({ routed: 0, deferred: 0, skipped: 0, errors: 0 }));

    const summary = await runWorker("ROUTE_LANE", { runLaneRouting } as never);

    expect(runLaneRouting).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ claimed: 1, completed: 0, failed: 1, deadLettered: 1 });
    const task = await taskRow(taskId);
    expect(task.status).toBe("DEAD_LETTER");
    expect(task.last_error).toContain("Lane routing did not advance");
  });

  it.each([
    { state: "HARD_REJECTED" as const, decision: "HARD_REJECT" },
    { state: "NEEDS_VERIFICATION" as const, decision: "NEEDS_VERIFICATION" },
  ])("a queued PUBLISH_EMBEDDING task completes as superseded when the gate moved the job to $state (non-routable), without provider work", async ({ state, decision }) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const job = await enqueueEmbeddingJob();
    await applyGateOutcome(job.canonicalJobId, state, decision);
    const dependencies = publishingDependencies(job.jobVersionId);

    const summary = await runWorker("PUBLISH_EMBEDDING", dependencies);

    expect(summary).toMatchObject({ claimed: 1, completed: 1, failed: 0, deadLettered: 0 });
    expect(dependencies.runEmbeddingBatchWithFallback).not.toHaveBeenCalled();
    expect(await routeTaskCount(job.jobVersionId)).toBe(0);
    expect((await jobRow(job.canonicalJobId)).processing_state).toBe(state);
  }, 120_000);

  it.each([
    { state: "HARD_REJECTED" as const, decision: "HARD_REJECT" },
    { state: "NEEDS_VERIFICATION" as const, decision: "NEEDS_VERIFICATION" },
  ])("producer: an embedding repair that finishes after the gate moved the job to $state (non-routable) queues no ROUTE_LANE task; a routable job still gets one", async ({ state, decision }) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rejected = await enqueueEmbeddingJob();
    // The gate-version refresh lands while the embedding task is running.
    const rejectedRun = await runWorker("PUBLISH_EMBEDDING", publishingDependencies(
      rejected.jobVersionId,
      () => applyGateOutcome(rejected.canonicalJobId, state, decision),
    ));
    expect(rejectedRun).toMatchObject({ claimed: 1, completed: 1, failed: 0, deadLettered: 0 });
    expect(await routeTaskCount(rejected.jobVersionId)).toBe(0);
    expect((await jobRow(rejected.canonicalJobId)).processing_state).toBe(state);

    const routable = await enqueueEmbeddingJob();
    const routableRun = await runWorker("PUBLISH_EMBEDDING", publishingDependencies(routable.jobVersionId));
    expect(routableRun).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(await routeTaskCount(routable.jobVersionId)).toBe(1);
  }, 120_000);

  it("routable NEEDS_VERIFICATION is not superseded: PUBLISH_EMBEDDING runs, ROUTE_LANE follows and runs, and the job is not stranded", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const job = await enqueueEmbeddingJob();
    await applyGateOutcome(job.canonicalJobId, "NEEDS_VERIFICATION", "NEEDS_VERIFICATION", "GATE_UNKNOWN_WORK_MODE");
    const dependencies = publishingDependencies(job.jobVersionId);

    const embedded = await runWorker("PUBLISH_EMBEDDING", dependencies);
    expect(embedded).toMatchObject({ claimed: 1, completed: 1, failed: 0, deadLettered: 0 });
    expect(dependencies.runEmbeddingBatchWithFallback).toHaveBeenCalledTimes(1);
    expect(await routeTaskCount(job.jobVersionId)).toBe(1);
    // A pending ROUTE_LANE task carries the job: it is not reported as stranded.
    expect((await routableVerificationJobsStranded(db(), context!.workspaceId)).sample).not.toContain(job.canonicalJobId);

    const runLaneRouting = vi.fn(async () => {
      await db().query(`UPDATE canonical_jobs SET processing_state = 'LANE_ROUTED', processing_status = 'LANE_ROUTED' WHERE id = $1`, [job.canonicalJobId]);
      return { routed: 1, deferred: 0, skipped: 0, errors: 0 };
    });
    const routed = await runWorker("ROUTE_LANE", { runLaneRouting } as never);
    expect(routed).toMatchObject({ claimed: 1, completed: 1, failed: 0, deadLettered: 0 });
    expect(runLaneRouting).toHaveBeenCalledTimes(1);
    expect(await taskRowByVersion(job.jobVersionId, "ROUTE_LANE")).toMatchObject({ status: "COMPLETED", repair_action: null });
    expect((await jobRow(job.canonicalJobId)).processing_state).toBe("LANE_ROUTED");
  }, 120_000);

  it("flip back: after a gate-superseded ROUTE_LANE repair, a re-enqueue of the same task reopens it and it routes the job", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const job = await insertJob("PREQUALIFIED");
    const taskId = await enqueueRouteRepair(job);
    await applyGateOutcome(job.canonicalJobId, "HARD_REJECTED", "HARD_REJECT");
    const first = await runWorker("ROUTE_LANE", { runLaneRouting: vi.fn() } as never);
    expect(first).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(await taskRow(taskId)).toMatchObject({ status: "COMPLETED", repair_action: "SUPERSEDED_BY_GATE_OUTCOME" });

    // A later gate version makes the job routable again; the same repair identity is enqueued again.
    await db().query(`UPDATE canonical_jobs SET processing_state = 'PREQUALIFIED', processing_status = 'PREQUALIFIED', gate_decision = 'PASS' WHERE id = $1`, [job.canonicalJobId]);
    expect(await enqueueRouteRepair(job)).toBe(taskId);
    expect(await taskRow(taskId)).toMatchObject({ status: "PENDING", repair_action: null });

    const runLaneRouting = vi.fn(async () => {
      await db().query(`UPDATE canonical_jobs SET processing_state = 'LANE_ROUTED', processing_status = 'LANE_ROUTED' WHERE id = $1`, [job.canonicalJobId]);
      return { routed: 1, deferred: 0, skipped: 0, errors: 0 };
    });
    const second = await runWorker("ROUTE_LANE", { runLaneRouting } as never);
    expect(second).toMatchObject({ claimed: 1, completed: 1, failed: 0, deadLettered: 0 });
    expect(runLaneRouting).toHaveBeenCalledTimes(1);
    expect((await jobRow(job.canonicalJobId)).processing_state).toBe("LANE_ROUTED");
  });

  it("an ordinary completed repair task is not reopened by a re-enqueue (only gate-superseded ones are)", async () => {
    const job = await insertJob("LANE_ROUTED");
    const taskId = await enqueueRouteRepair(job);
    await db().query(`UPDATE pipeline_tasks SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`, [taskId]);
    expect(await enqueueRouteRepair(job)).toBe(taskId);
    expect((await taskRow(taskId)).status).toBe("COMPLETED");
  });

  it("a RETRY_WAIT ROUTE_LANE task is claimed through the same check and superseded when the job is gate-rejected", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const job = await insertJob("PREQUALIFIED");
    const taskId = await enqueueRouteRepair(job);
    await db().query(
      `UPDATE pipeline_tasks SET status = 'RETRY_WAIT', attempt_count = 2, available_at = NOW() - INTERVAL '1 second', last_error = 'Lane routing did not advance' WHERE id = $1`,
      [taskId],
    );
    await applyGateOutcome(job.canonicalJobId, "HARD_REJECTED", "HARD_REJECT");
    const summary = await runWorker("ROUTE_LANE", { runLaneRouting: vi.fn() } as never);
    expect(summary).toMatchObject({ claimed: 1, completed: 1, failed: 0, deadLettered: 0 });
    expect(await taskRow(taskId)).toMatchObject({ status: "COMPLETED", repair_action: "SUPERSEDED_BY_GATE_OUTCOME", dead_letter_reason: null });
    expect((await jobRow(job.canonicalJobId)).processing_state).toBe("HARD_REJECTED");
  });

  it("a BLOCKED_DEPENDENCY ROUTE_LANE task is reactivated to PENDING by its repair and then superseded when the job is gate-rejected", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const job = await insertJob("PREQUALIFIED");
    const taskId = await enqueueRouteRepair(job);
    await db().query(
      `UPDATE pipeline_tasks SET status = 'BLOCKED_DEPENDENCY', blocked_on = 'PUBLISH_EMBEDDING:x', blocked_reason = 'fixture' WHERE id = $1`,
      [taskId],
    );
    await applyGateOutcome(job.canonicalJobId, "HARD_REJECTED", "HARD_REJECT");
    expect(await enqueueRouteRepair(job)).toBe(taskId);
    expect((await taskRow(taskId)).status).toBe("PENDING");
    const summary = await runWorker("ROUTE_LANE", { runLaneRouting: vi.fn() } as never);
    expect(summary).toMatchObject({ claimed: 1, completed: 1, failed: 0, deadLettered: 0 });
    expect(await taskRow(taskId)).toMatchObject({ status: "COMPLETED", repair_action: "SUPERSEDED_BY_GATE_OUTCOME" });
  });

  it("guard: MATCH_PROFILE_EVIDENCE on a gate-rejected job is a recorded no-op (MATCH_NOT_APPLICABLE, no match run, no decision task)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const job = await insertJob("LANE_ROUTED");
    const profileVersionId = (await db().query<{ id: string }>(
      `SELECT id::text AS id FROM profile_versions WHERE workspace_id = $1 AND status = 'ACTIVE' LIMIT 1`, [context!.workspaceId])).rows[0]!.id;
    const enqueued = await enqueuePipelineTask({
      taskType: "MATCH_PROFILE_EVIDENCE",
      taskKey: `MATCH_PROFILE_EVIDENCE:${job.jobVersionId}:deterministic_matcher_v1:${profileVersionId}`,
      payload: { canonical_job_id: job.canonicalJobId, job_version_id: job.jobVersionId, profile_version_id: profileVersionId },
    }, db(), { context: context! });
    await applyGateOutcome(job.canonicalJobId, "HARD_REJECTED", "HARD_REJECT");
    const runDeterministicMatcher = vi.fn();
    const summary = await runWorker("MATCH_PROFILE_EVIDENCE", { runDeterministicMatcher } as never);
    expect(summary).toMatchObject({ claimed: 1, completed: 1, failed: 0, deadLettered: 0 });
    expect(runDeterministicMatcher).not.toHaveBeenCalled();
    expect(await taskRow(enqueued.taskId)).toMatchObject({ status: "COMPLETED", repair_action: "MATCH_NOT_APPLICABLE:HARD_REJECTED" });
    expect((await db().query(`SELECT 1 FROM match_runs WHERE canonical_job_id = $1`, [job.canonicalJobId])).rows).toEqual([]);
    expect((await db().query(`SELECT 1 FROM pipeline_tasks WHERE task_type = 'DECIDE_RECOMMENDATION' AND payload->>'job_version_id' = $1`, [job.jobVersionId])).rows).toEqual([]);
    expect((await jobRow(job.canonicalJobId)).processing_state).toBe("HARD_REJECTED");
  });
});
