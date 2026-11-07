import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import dotenv from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { fetchJobContent, type PostingFetcherDependencies, type SafeHttpResponse } from "../../ingestion/jobContentFetcher.js";
import { PgEmployerBoardResolutionCache } from "../../ingestion/employerBoardLookup.js";
import { isFetchedPostingReceiptBoundToObservation } from "../../ingestion/jobSourceEvidence.js";
import { runHardGates } from "../../pipeline/hardGate.js";
import { runNormalization } from "../../pipeline/normalize.js";
import { runRequirementsExtraction } from "../../pipeline/requirementsExtractor.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { runPipelineStageTaskWorker, type PipelineStageWorkerDependencies } from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { parseRequeueArguments, requeueLinkedInContentBlocks } from "../../../scripts/requeue_linkedin_content_blocks.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run employer-board lookup integration tests against its PostgreSQL service.");
}

// Synthetic employer, board and posting fixtures only.
const EMPLOYER = "Northwind Synthetic Analytics Pte. Ltd.";
const BOARD = "northwindsyntheticanalytics";
const TITLE = "Synthetic Data Architect";
const DESCRIPTION = [
  "<p>About the role: the team builds a synthetic data platform for regional operations groups.</p>",
  "<h3>Responsibilities</h3><ul><li>Lead the architecture of data pipelines and review designs with engineering squads.</li>",
  "<li>Coordinate delivery with product owners, document decisions and manage production risks.</li></ul>",
  "<h3>Requirements</h3><ul><li>Experience designing cloud data platforms and streaming systems in production.</li>",
  "<li>Strong stakeholder communication, mentoring and delivery skills across distributed teams.</li></ul>",
].join("");

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
const savedEnv: Record<string, string | undefined> = {};

function getClient(): pg.PoolClient {
  if (!client) throw new Error("Employer-board integration test database is not initialized.");
  return client;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("Employer-board integration test workspace is not initialized.");
  return context;
}

type Reply = { status: number; body: unknown; contentType?: string } | Error;

/** Deterministic transport: LinkedIn shows its sign-in wall; the employer board is Greenhouse. */
function boardTransport(requests: string[], override?: (url: URL) => Reply | undefined): PostingFetcherDependencies {
  const jobs = [
    {
      id: 7001,
      title: TITLE,
      company_name: "Northwind Synthetic Analytics",
      location: { name: "Singapore" },
      absolute_url: `https://job-boards.greenhouse.io/${BOARD}/jobs/7001`,
      updated_at: "2026-11-01T00:00:00Z",
    },
    {
      id: 7002,
      title: "Platform Engineer",
      company_name: "Northwind Synthetic Analytics",
      location: { name: "London, United Kingdom" },
      absolute_url: `https://job-boards.greenhouse.io/${BOARD}/jobs/7002`,
      updated_at: "2026-11-01T00:00:00Z",
    },
  ];
  const route = (url: URL): Reply => {
    const overridden = override?.(url);
    if (overridden) return overridden;
    if (url.hostname === "www.linkedin.com") return { status: 403, body: "Sign in to view this job", contentType: "text/html" };
    if (url.hostname !== "boards-api.greenhouse.io") return { status: 404, body: { error: "not found" } };
    if (url.pathname === `/v1/boards/${BOARD}`) return { status: 200, body: { name: "Northwind Synthetic Analytics" } };
    if (url.pathname === `/v1/boards/${BOARD}/jobs`) return { status: 200, body: { jobs } };
    const detail = jobs.find((job) => url.pathname === `/v1/boards/${BOARD}/jobs/${job.id}`);
    if (detail && url.searchParams.get("content") === "true") {
      return { status: 200, body: { ...detail, content: DESCRIPTION } };
    }
    return { status: 404, body: { error: "not found" } };
  };
  return {
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    now: () => new Date("2026-11-07T06:00:00.000Z"),
    fetchOnce: async (url): Promise<SafeHttpResponse> => {
      requests.push(url.toString());
      const reply = route(url);
      if (reply instanceof Error) throw reply;
      return {
        url: url.toString(),
        status: reply.status,
        headers: { "content-type": reply.contentType ?? "application/json" },
        body: Buffer.from(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), "utf8"),
      };
    },
  };
}

function workerDependencies(transport: PostingFetcherDependencies): PipelineStageWorkerDependencies {
  const unusedStage = async (): Promise<never> => {
    throw new Error("A later pipeline stage was called outside the employer-board test scope.");
  };
  return {
    // The worker supplies the production employer-board fallback (Postgres cache); only the HTTP
    // transport is replaced so no live network is used.
    fetchJobContent: (url, expected, deps) => fetchJobContent(url, expected, { ...deps, ...transport }),
    runNormalization,
    runRequirementsExtraction,
    runHardGates,
    runEmbeddingBatchWithFallback: unusedStage as PipelineStageWorkerDependencies["runEmbeddingBatchWithFallback"],
    runLaneRouting: unusedStage as PipelineStageWorkerDependencies["runLaneRouting"],
    runDeterministicMatcher: unusedStage as PipelineStageWorkerDependencies["runDeterministicMatcher"],
    runRecommendationDecider: unusedStage as PipelineStageWorkerDependencies["runRecommendationDecider"],
    runExplanationQueueEnqueuer: unusedStage as PipelineStageWorkerDependencies["runExplanationQueueEnqueuer"],
  };
}

async function insertLinkedInCard(input: { title: string; company: string; location: string; jobId: string }): Promise<string> {
  const observationId = randomUUID();
  const messageId = `employer-board-${randomUUID()}`;
  const rawPayload = { message_id: messageId, subject: `Job alert: ${input.title}`, body_text: "View job on LinkedIn." };
  await getClient().query(
    `INSERT INTO raw_job_observations (
       id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
       company_name, title, location_raw, description_raw, raw_payload, raw_payload_hash, processing_status,
       gmail_message_id
     ) VALUES ($1, $2, 'GMAIL_ALERT', $3, $4, NOW(), $5, $6, $7, 'LinkedIn alert card',
       $8::jsonb, $9, 'FETCH_PENDING', $10)`,
    [observationId, getContext().workspaceId, `gmail-${messageId}`, `https://www.linkedin.com/jobs/view/${input.jobId}`,
      input.company, input.title, input.location, JSON.stringify(rawPayload),
      createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex"), messageId],
  );
  return observationId;
}

async function enqueueFetch(observationId: string): Promise<string> {
  const requestId = randomUUID();
  const result = await enqueuePipelineTask({
    taskType: "FETCH_JOB_CONTENT",
    taskKey: `FETCH_JOB_CONTENT:${observationId}:posting_fetch_v1:${requestId}`,
    payload: { observation_id: observationId },
    maxAttempts: 8,
    producer: "employer_board_lookup_integration_test",
    stageVersion: "posting_fetch_v1",
    requestId,
  }, getClient(), { context: getContext() });
  return result.taskId;
}

async function runStages(observationId: string, transport: PostingFetcherDependencies, maxTasks = 1) {
  return runPipelineStageTaskWorker(getClient(), {
    context: getContext(),
    seed: false,
    reconcileStalePending: false,
    observationIds: [observationId],
    taskTypes: ["FETCH_JOB_CONTENT", "NORMALIZE_OBSERVATION"],
    maxTasks,
    maxTasksByType: { FETCH_JOB_CONTENT: 1, NORMALIZE_OBSERVATION: 1 },
    stageQuantum: 1,
    claimBatchSize: 1,
    wallClockMs: 30_000,
    minTimeToStartTaskMs: 0,
    heartbeatSeconds: 0,
    claimedBy: "employer-board-integration",
  }, workerDependencies(transport));
}

async function taskState(taskId: string) {
  const { rows } = await getClient().query<{
    status: string;
    blocked_on: string | null;
    repair_action: string | null;
    last_error: string | null;
    processing_status: string;
  }>(
    `SELECT task.status, task.blocked_on, task.repair_action, task.last_error, observation.processing_status
     FROM pipeline_tasks task
     JOIN raw_job_observations observation ON observation.workspace_id = task.workspace_id
       AND observation.id::text = task.payload->>'observation_id'
     WHERE task.workspace_id = $1 AND task.id = $2::uuid`,
    [getContext().workspaceId, taskId],
  );
  return rows[0];
}

describe("LinkedIn content-block requeue arguments", () => {
  it("is a dry run unless --apply is given and bounds the batch", () => {
    expect(parseRequeueArguments(["--workspace-key", "ws"])).toEqual({ workspaceKey: "ws", limit: 200, apply: false });
    expect(parseRequeueArguments(["--workspace-key", "ws", "--limit", "25", "--apply"]))
      .toEqual({ workspaceKey: "ws", limit: 25, apply: true });
    expect(() => parseRequeueArguments(["--apply"])).toThrow("--workspace-key is required.");
    expect(() => parseRequeueArguments(["--workspace-key", "ws", "--limit", "5000"])).toThrow("--limit");
    expect(() => parseRequeueArguments(["--workspace-key", "ws", "--force"])).toThrow("Unexpected");
  });
});

describe.skipIf(skipReal)("LinkedIn employer-board lookup in FETCH_JOB_CONTENT (PostgreSQL)", () => {
  beforeAll(async () => {
    for (const key of ["SEARCHAPI_LINKEDIN_ENABLED", "SEARCHAPI_API_KEY", "EMPLOYER_BOARD_LOOKUP_ENABLED"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `employer_board_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    const applied = await runMigrations(client, { migrationsDir: path.resolve(process.cwd(), "migrations") });
    if (!applied.includes("100_employer_board_resolutions.sql")) {
      throw new Error("Migration 100 was not applied to the integration schema.");
    }
    context = await resolveWorkspaceContext(client);
  }, 120_000);

  afterAll(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("stages the employer-board posting with LinkedIn lineage, caches the board, and normalizes it", async () => {
    const observationId = await insertLinkedInCard({ title: TITLE, company: EMPLOYER, location: "Singapore (Hybrid)", jobId: "4100000001" });
    const taskId = await enqueueFetch(observationId);
    const requests: string[] = [];

    const run = await runStages(observationId, boardTransport(requests), 2);

    expect(run.byType.FETCH_JOB_CONTENT).toMatchObject({ claimed: 1, completed: 1 });
    expect(run.byType.NORMALIZE_OBSERVATION).toMatchObject({ claimed: 1, completed: 1 });
    expect((await taskState(taskId))?.status).toBe("COMPLETED");

    const { rows } = await getClient().query<{
      id: string;
      source_name: string;
      source_url: string;
      canonical_apply_url: string | null;
      company_name: string;
      title: string;
      description_raw: string;
      raw_payload: Record<string, unknown>;
      job_version_id: string | null;
      normalized_evidence: { availability?: { status?: string } } | null;
      parent_status: string;
      parent_url: string;
    }>(
      `SELECT derived.id::text, derived.source_name, derived.source_url, derived.canonical_apply_url,
              derived.company_name, derived.title, derived.description_raw, derived.raw_payload,
              derived.job_version_id::text, derived.normalized_evidence,
              parent.processing_status AS parent_status, parent.source_url AS parent_url
       FROM raw_job_observations derived
       JOIN raw_job_observations parent ON parent.workspace_id = derived.workspace_id
         AND parent.id = derived.derived_from_observation_id
       WHERE derived.workspace_id = $1 AND derived.derived_from_observation_id = $2::uuid`,
      [getContext().workspaceId, observationId],
    );
    expect(rows).toHaveLength(1);
    const derived = rows[0];
    if (!derived) return;
    expect(derived).toMatchObject({
      source_name: "GREENHOUSE",
      source_url: `https://job-boards.greenhouse.io/${BOARD}/jobs/7001`,
      canonical_apply_url: `https://job-boards.greenhouse.io/${BOARD}/jobs/7001`,
      company_name: "Northwind Synthetic Analytics",
      title: TITLE,
      // FETCH_COMPLETE after the fetch, then PROCESSED once normalization maps the version.
      parent_status: "PROCESSED",
    });
    expect(derived.job_version_id).not.toBeNull();
    expect(derived.raw_payload).toMatchObject({
      source_content_status: "COMPLETE",
      discovery_observation_id: observationId,
      requested_url: "https://www.linkedin.com/jobs/view/4100000001",
      canonical_url: `https://job-boards.greenhouse.io/${BOARD}/jobs/7001`,
      source_provider: "GREENHOUSE",
      employer_board_lookup: {
        linkedin_job_id: "4100000001",
        provider: "GREENHOUSE",
        board_token: BOARD,
        employer_key: "northwind synthetic analytics",
        resolution_method: "DERIVED_SLUG",
        resolution_cached: false,
      },
    });
    // The Gmail receipt contract still binds the employer posting to its exact LinkedIn parent.
    expect(isFetchedPostingReceiptBoundToObservation(derived.raw_payload, {
      discoveryObservationId: observationId,
      discoverySourceUrl: derived.parent_url,
      postingSourceUrl: derived.source_url,
      companyName: derived.company_name,
      title: derived.title,
      description: derived.description_raw,
    })).toBe(true);
    expect(derived.normalized_evidence?.availability?.status).toBe("OPEN");

    const cached = await new PgEmployerBoardResolutionCache(getClient()).get("northwind synthetic analytics", new Date("2026-11-07T06:00:00.000Z"));
    expect(cached).toMatchObject({
      status: "FOUND",
      provider: "GREENHOUSE",
      boardToken: BOARD,
      boardName: "Northwind Synthetic Analytics",
      resolutionMethod: "DERIVED_SLUG",
      candidatesTried: [`GREENHOUSE:${BOARD}`],
    });
    expect(requests.filter((url) => url.includes("content=true"))).toHaveLength(1);
  });

  it("blocks a card the cached board has no posting for, without probing the board again", async () => {
    const observationId = await insertLinkedInCard({ title: "Quantum Archivist", company: EMPLOYER, location: "Singapore", jobId: "4100000002" });
    const taskId = await enqueueFetch(observationId);
    const requests: string[] = [];

    const run = await runStages(observationId, boardTransport(requests));

    expect(run.byType.FETCH_JOB_CONTENT).toMatchObject({ claimed: 1, blocked: 1 });
    const state = await taskState(taskId);
    expect(state).toMatchObject({
      status: "BLOCKED_DEPENDENCY",
      blocked_on: "JOB_CONTENT",
      repair_action: "PROVIDE_EMPLOYER_URL_OR_FULL_JD",
      processing_status: "FETCH_BLOCKED",
    });
    expect(state?.last_error).toContain("POSTING_CONTENT_BLOCKED: EMPLOYER_BOARD_NO_MATCH");
    expect(requests).not.toContain(`https://boards-api.greenhouse.io/v1/boards/${BOARD}`);
    const history = await getClient().query<{ error_history: Array<{ error: string }> }>(
      `SELECT error_history FROM raw_job_observations WHERE workspace_id = $1 AND id = $2::uuid`,
      [getContext().workspaceId, observationId],
    );
    expect(history.rows[0]?.error_history.at(-1)?.error).toContain("EMPLOYER_BOARD_NO_MATCH");
  });

  it("caches an employer without a public board and blocks with EMPLOYER_BOARD_NOT_FOUND", async () => {
    const observationId = await insertLinkedInCard({ title: TITLE, company: "Contoso Imaginary Holdings", location: "Singapore", jobId: "4100000003" });
    const taskId = await enqueueFetch(observationId);

    const run = await runStages(observationId, boardTransport([]));

    expect(run.byType.FETCH_JOB_CONTENT).toMatchObject({ claimed: 1, blocked: 1 });
    expect((await taskState(taskId))?.last_error).toContain("EMPLOYER_BOARD_NOT_FOUND");
    const row = await getClient().query<{ status: string; provider: string | null; ttl_days: number }>(
      `SELECT status, provider, ROUND(EXTRACT(EPOCH FROM (expires_at - resolved_at)) / 86400)::int AS ttl_days
       FROM employer_board_resolutions WHERE employer_key = 'contoso imaginary holdings'`,
    );
    expect(row.rows[0]).toEqual({ status: "NOT_FOUND", provider: null, ttl_days: 7 });
  });

  it("keeps a board-API outage retryable, never blocked, and caches nothing", async () => {
    const observationId = await insertLinkedInCard({ title: TITLE, company: "Fabrikam Synthetic Labs", location: "Singapore", jobId: "4100000004" });
    const taskId = await enqueueFetch(observationId);
    const outage = (url: URL): Reply | undefined => (url.hostname === "boards-api.greenhouse.io"
      ? { status: 503, body: { error: "unavailable" } }
      : undefined);

    const run = await runStages(observationId, boardTransport([], outage));

    expect(run.byType.FETCH_JOB_CONTENT).toMatchObject({ claimed: 1, failed: 1 });
    expect(await taskState(taskId)).toMatchObject({ status: "RETRY_WAIT", processing_status: "FETCH_PENDING" });
    const cached = await getClient().query(
      `SELECT 1 FROM employer_board_resolutions WHERE employer_key = 'fabrikam synthetic labs'`,
    );
    expect(cached.rows).toHaveLength(0);
  });

  it("requeues a LinkedIn fetch blocked before the lookup existed, and never one the lookup settled", async () => {
    const observationId = await insertLinkedInCard({ title: "Platform Engineer", company: EMPLOYER, location: "London, England, United Kingdom", jobId: "4100000005" });
    const taskId = await enqueueFetch(observationId);
    // Reproduce the pre-change outcome: the LinkedIn page alone, no employer-board fallback.
    process.env.EMPLOYER_BOARD_LOOKUP_ENABLED = "false";
    try {
      const blockedRun = await runStages(observationId, boardTransport([]));
      expect(blockedRun.byType.FETCH_JOB_CONTENT).toMatchObject({ claimed: 1, blocked: 1 });
    } finally {
      delete process.env.EMPLOYER_BOARD_LOOKUP_ENABLED;
    }
    expect((await taskState(taskId))?.last_error).toContain("POSTING_CONTENT_BLOCKED: AUTH_REQUIRED");

    const dryRun = await requeueLinkedInContentBlocks(getClient(), getContext(), { limit: 50, apply: false });
    expect(dryRun.taskIds).toContain(taskId);
    // Tasks the lookup already blocked (earlier tests) are not selected again.
    const settled = await getClient().query<{ id: string }>(
      `SELECT id::text FROM pipeline_tasks WHERE workspace_id = $1 AND last_error LIKE '%EMPLOYER_BOARD_%'`,
      [getContext().workspaceId],
    );
    expect(settled.rows.length).toBeGreaterThan(0);
    expect(dryRun.taskIds.some((id) => settled.rows.some((row) => row.id === id))).toBe(false);
    expect((await taskState(taskId))?.status).toBe("BLOCKED_DEPENDENCY");

    const applied = await requeueLinkedInContentBlocks(getClient(), getContext(), { limit: 50, apply: true });
    expect(applied).toMatchObject({ mode: "APPLY", selected: dryRun.selected, requeued: dryRun.selected });
    expect(await taskState(taskId)).toMatchObject({ status: "PENDING", blocked_on: null, processing_status: "FETCH_PENDING" });

    const retried = await runStages(observationId, boardTransport([]));
    expect(retried.byType.FETCH_JOB_CONTENT).toMatchObject({ claimed: 1, completed: 1 });
    expect((await taskState(taskId))?.processing_status).toBe("FETCH_COMPLETE");
    expect((await requeueLinkedInContentBlocks(getClient(), getContext(), { limit: 50, apply: false })).taskIds).not.toContain(taskId);
  });

  it("rejects inconsistent cache rows at the database boundary", async () => {
    await expect(getClient().query(
      `INSERT INTO employer_board_resolutions (
         employer_key, employer_name, status, provider, board_token, resolution_method, resolver_version, expires_at
       ) VALUES ('inconsistent', 'Inconsistent', 'NOT_FOUND', 'LEVER', 'board', 'NONE', 'test', NOW() + INTERVAL '1 day')`,
    )).rejects.toMatchObject({ code: "23514" });
  });
});
