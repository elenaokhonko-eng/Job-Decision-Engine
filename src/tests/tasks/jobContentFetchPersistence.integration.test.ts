import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { fetchJobContent, type PostingFetcherDependencies, type SafeHttpResponse } from "../../ingestion/jobContentFetcher.js";
import { runHardGates } from "../../pipeline/hardGate.js";
import { runNormalization } from "../../pipeline/normalize.js";
import { runRequirementsExtraction } from "../../pipeline/requirementsExtractor.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { runPipelineStageTaskWorker, type PipelineStageWorkerDependencies } from "../../tasks/stageTaskWorker.js";
import { runRepairBacklogBatch } from "../../../scripts/repair_job_content_backlog.js";
import { buildEmailAlertSelectionQuery } from "../../ingestion/emailParserReplay.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run posting persistence integration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function getClient(): pg.PoolClient {
  if (!client) throw new Error("Posting persistence integration test database is not initialized.");
  return client;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("Posting persistence integration test workspace is not initialized.");
  return context;
}

function response(url: URL, value: unknown): SafeHttpResponse {
  return {
    url: url.toString(),
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: Buffer.from(JSON.stringify(value), "utf8"),
  };
}

const postingId = "c3c8f47e-0c30-458b-a74f-53cd6dc09137";
const postingTitle = "Data & AI - Technical Project Manager";
const postingDescription = [
  "This role leads data and AI consulting delivery for client organizations and coordinates complex technical programs.",
  "Responsibilities: Set delivery plans, guide engineers, manage scope and commercial outcomes, and present to executive stakeholders.",
  "Requirements: Demonstrated experience in data platforms, AI delivery, project management, client communication, and risk controls.",
  "The successful candidate works with cross-functional teams, documents decisions, resolves delivery risks, and supports implementation.",
].join(" ").repeat(4);

function postingDependencies(): PostingFetcherDependencies {
  return {
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchOnce: async (url) => response(url, {
      id: postingId,
      text: postingTitle,
      companyName: "CFGI",
      hostedUrl: `https://jobs.lever.co/cfgi/${postingId}`,
      applyUrl: `https://jobs.lever.co/cfgi/${postingId}/apply`,
      categories: { location: "United States", commitment: "Full-time" },
      workplaceType: "remote",
      createdAt: Date.parse("2025-08-01T12:00:00Z"),
      salaryRange: { currency: "USD", interval: "yearly", min: 150000, max: 200000 },
      descriptionPlain: postingDescription,
    }),
    now: () => new Date("2026-10-28T00:00:00.000Z"),
  };
}

function dependencies(
  fetcher: PipelineStageWorkerDependencies["fetchJobContent"],
): PipelineStageWorkerDependencies {
  const unusedStage = async (): Promise<never> => {
    throw new Error("A later pipeline stage was called outside the posting persistence test scope.");
  };
  return {
    fetchJobContent: fetcher,
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

async function insertGmailObservation(input: { title: string; url: string; messageId: string }): Promise<string> {
  const observationId = randomUUID();
  const rawPayload = {
    message_id: input.messageId,
    subject: `Job alert: ${input.title}`,
    body_text: "View this role and apply online.",
  };
  const rawPayloadHash = createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex");
  await getClient().query(
    `INSERT INTO raw_job_observations (
       id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
       company_name, title, description_raw, raw_payload, raw_payload_hash, processing_status,
       gmail_message_id
     ) VALUES ($1, $2, 'GMAIL_ALERT', $3, $4, NOW(), 'CFGI', $5, 'short Gmail alert snippet',
       $6::jsonb, $7, 'FETCH_PENDING', $8)`,
    [observationId, getContext().workspaceId, `gmail-${input.messageId}`, input.url, input.title,
      JSON.stringify(rawPayload), rawPayloadHash, input.messageId],
  );
  return observationId;
}

async function enqueueFetch(observationId: string, requestId: string): Promise<string> {
  const taskKey = `FETCH_JOB_CONTENT:${observationId}:posting_fetch_v1:${requestId}`;
  const result = await enqueuePipelineTask({
    taskType: "FETCH_JOB_CONTENT",
    taskKey,
    payload: { observation_id: observationId },
    maxAttempts: 8,
    producer: "job_content_fetch_integration_test",
    stageVersion: "posting_fetch_v1",
    requestId,
  }, getClient(), { context: getContext() });
  return result.taskId;
}

async function runBoundedStages(
  observationId: string,
  workerDependencies: PipelineStageWorkerDependencies,
  maxTasks = 1,
) {
  return runPipelineStageTaskWorker(getClient(), {
    context: getContext(),
    seed: false,
    reconcileStalePending: false,
    observationIds: [observationId],
    taskTypes: [
      "FETCH_JOB_CONTENT",
      "NORMALIZE_OBSERVATION",
      "EXTRACT_DETERMINISTIC_REQUIREMENTS",
      "APPLY_HARD_GATES",
    ],
    maxTasks,
    maxTasksByType: {
      FETCH_JOB_CONTENT: 1,
      NORMALIZE_OBSERVATION: 1,
      EXTRACT_DETERMINISTIC_REQUIREMENTS: 1,
      APPLY_HARD_GATES: 1,
    },
    stageQuantum: 1,
    claimBatchSize: 1,
    wallClockMs: 30_000,
    minTimeToStartTaskMs: 0,
    heartbeatSeconds: 0,
    claimedBy: "posting-persistence-integration",
  }, workerDependencies);
}

describe.skipIf(skipReal)("Gmail posting retrieval persistence (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `posting_fetch_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    const migrationsRoot = path.resolve(process.cwd(), "migrations");
    const legacyMigrationsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "posting-fetch-migrations-"));
    try {
      const migrationFiles = await fs.readdir(migrationsRoot);
      for (const file of migrationFiles) {
        const prefix = file.match(/^(\d+)[a-z]?_.*\.sql$/)?.[1];
        if (prefix && Number(prefix) <= 79) {
          await fs.copyFile(path.join(migrationsRoot, file), path.join(legacyMigrationsRoot, file));
        }
      }
      const initializedThrough079 = await runMigrations(client, { migrationsDir: legacyMigrationsRoot });
      if (!initializedThrough079.some((file) => file.startsWith("079_"))) {
        throw new Error("The integration fixture did not initialize through migration 079.");
      }
    } finally {
      await fs.rm(legacyMigrationsRoot, { recursive: true, force: true });
    }
    const upgraded = await runMigrations(client);
    if (!upgraded.includes("081_gmail_posting_retrieval_lineage.sql")) {
      throw new Error("Upgrade from the 079 baseline did not apply migration 081.");
    }
    const replayed = await runMigrations(client);
    if (replayed.length !== 0) throw new Error(`Migration replay unexpectedly applied: ${replayed.join(", ")}`);
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

  it("resumes a cursor checkpoint in bounded pages without losing candidates", async () => {
    const observationIds: string[] = [];
    for (let index = 0; index < 27; index += 1) {
      observationIds.push(await insertGmailObservation({
        title: `Backlog fixture role ${index + 1}`,
        url: `https://jobs.example.test/backlog/${index + 1}`,
        messageId: `backlog-${index + 1}-${randomUUID()}`,
      }));
    }

    const runKey = `gmail-backlog-${randomUUID()}`;
    const first = await runRepairBacklogBatch(getClient(), getContext(), {
      runKey,
      batchSize: 25,
      apply: true,
    });
    expect(first).toMatchObject({
      status: "RUNNING",
      hasMore: true,
      totals: { scanned: 25, enqueued: 25, skipped: 0 },
    });
    expect(first.runId).toBeTruthy();

    const resumed = await runRepairBacklogBatch(getClient(), getContext(), {
      runKey,
      batchSize: 25,
      apply: true,
    });
    expect(resumed).toMatchObject({
      runId: first.runId,
      status: "COMPLETED",
      hasMore: false,
      totals: { scanned: 27, enqueued: 27, skipped: 0 },
    });
    expect(new Set([...first.candidates, ...resumed.candidates].map((candidate) => candidate.observationId)).size)
      .toBe(27);
    expect(observationIds.every((id) => [...first.candidates, ...resumed.candidates].some((candidate) => candidate.observationId === id)))
      .toBe(true);

    const persisted = await getClient().query<{ task_count: number; checkpoint: Record<string, unknown>; status: string }>(
      `SELECT COUNT(task.id)::int AS task_count, run.status,
              checkpoint.checkpoint
       FROM backfill_runs run
       JOIN backfill_checkpoints checkpoint ON checkpoint.workspace_id = run.workspace_id
         AND checkpoint.backfill_run_id = run.id AND checkpoint.step_key = 'gmail_posting_retrieval_v1'
       LEFT JOIN pipeline_tasks task ON task.workspace_id = run.workspace_id
         AND task.task_type = 'FETCH_JOB_CONTENT'
         AND task.task_key LIKE 'FETCH_JOB_CONTENT:%:backfill:' || run.id::text
       WHERE run.workspace_id = $1 AND run.id = $2::uuid
       GROUP BY run.status, checkpoint.checkpoint`,
      [getContext().workspaceId, first.runId],
    );
    expect(persisted.rows[0]?.task_count).toBe(27);
    expect(persisted.rows[0]?.status).toBe("COMPLETED");
    expect(persisted.rows[0]?.checkpoint).toMatchObject({ status: "COMPLETED", scanned: 27, enqueued: 27 });
  });

  it("makes parser-blocked alerts replayable while keeping ordinary source blocks out of parser replay", async () => {
    const workspaceId = getContext().workspaceId;
    const replayId = randomUUID();
    const newAlertId = randomUUID();
    const fetchBlockedId = randomUUID();
    await getClient().query(
      `INSERT INTO raw_email_alerts (
         id, workspace_id, gmail_message_id, subject, body, processed, lifecycle_status, last_error, received_at
       ) VALUES
         ($1, $4, $5, 'Parser blocked fixture', 'job alert body', TRUE, 'SOURCE_BLOCKED', 'MISSING_POSTING_URL: prior parser defect', NOW() - INTERVAL '2 days'),
         ($2, $4, $6, 'New alert fixture', 'job alert body', FALSE, 'STAGED', NULL, NOW() - INTERVAL '1 day'),
         ($3, $4, $7, 'Fetch block fixture', 'job alert body', TRUE, 'SOURCE_BLOCKED', 'POSTING_CONTENT_BLOCKED: bot protection', NOW())`,
      [replayId, newAlertId, fetchBlockedId, workspaceId,
        `parser-replay-${replayId}`, `parser-new-${newAlertId}`, `parser-fetch-blocked-${fetchBlockedId}`],
    );

    const normal = await getClient().query<{ id: string }>(
      buildEmailAlertSelectionQuery(false), [workspaceId, 20],
    );
    expect(normal.rows.map((row) => row.id)).toEqual([newAlertId]);

    const replay = await getClient().query<{ id: string }>(
      buildEmailAlertSelectionQuery(true), [workspaceId, 20],
    );
    expect(new Set(replay.rows.map((row) => row.id))).toEqual(new Set([replayId, newAlertId]));
    expect(replay.rows.map((row) => row.id)).not.toContain(fetchBlockedId);
  });

  it("retries safely, persists the exact posting version, and runs deterministic requirements and gates", async () => {
    const sourceUrl = `https://jobs.lever.co/cfgi/${postingId}`;
    const observationId = await insertGmailObservation({
      title: postingTitle,
      url: sourceUrl,
      messageId: `fixture-${randomUUID()}`,
    });
    const taskId = await enqueueFetch(observationId, `initial-${randomUUID()}`);

    const transientFailure = await runBoundedStages(observationId, dependencies(async () => ({
      kind: "RETRYABLE_FAILURE",
      reason: "deterministic fixture outage",
    })));
    expect(transientFailure.byType.FETCH_JOB_CONTENT).toMatchObject({ claimed: 1, failed: 1 });
    const failedState = await getClient().query<{ status: string; processing_status: string; version_count: number }>(
      `SELECT task.status, observation.processing_status,
              (SELECT COUNT(*)::int FROM job_versions version WHERE version.workspace_id = observation.workspace_id
                AND version.canonical_job_id = canonical.id) AS version_count
       FROM pipeline_tasks task
       JOIN raw_job_observations observation ON observation.workspace_id = task.workspace_id
         AND observation.id::text = task.payload->>'observation_id'
       LEFT JOIN job_versions original_version ON original_version.workspace_id = observation.workspace_id
         AND original_version.id = observation.job_version_id
       LEFT JOIN canonical_jobs canonical ON canonical.workspace_id = original_version.workspace_id
         AND canonical.id = original_version.canonical_job_id
       WHERE task.id = $1`,
      [taskId],
    );
    expect(failedState.rows[0]).toMatchObject({ status: "RETRY_WAIT", processing_status: "FETCH_PENDING", version_count: 0 });

    await getClient().query(
      `UPDATE pipeline_tasks SET status = 'PENDING', available_at = NOW() - INTERVAL '1 minute'
       WHERE workspace_id = $1 AND id = $2`,
      [getContext().workspaceId, taskId],
    );
    const fetcher: PipelineStageWorkerDependencies["fetchJobContent"] = (url, expected) =>
      fetchJobContent(url, expected, postingDependencies());
    const completed = await runBoundedStages(observationId, dependencies(fetcher), 4);
    expect(completed.byType.FETCH_JOB_CONTENT).toMatchObject({ claimed: 1, completed: 1 });
    expect(completed.byType.NORMALIZE_OBSERVATION).toMatchObject({ claimed: 1, completed: 1 });
    expect(completed.byType.EXTRACT_DETERMINISTIC_REQUIREMENTS).toMatchObject({ claimed: 1, completed: 1 });
    expect(completed.byType.APPLY_HARD_GATES).toMatchObject({ claimed: 1, completed: 1 });

    const source = await getClient().query<{
      id: string;
      source_name: string;
      processing_status: string;
      description_raw: string;
      raw_payload: Record<string, unknown>;
      derived_from_observation_id: string | null;
      job_version_id: string | null;
      published_at: string | null;
      workplace_type_raw: string | null;
      compensation_raw: string | null;
      normalized_evidence: Record<string, unknown> | null;
    }>(
      `SELECT id::text, source_name, processing_status, description_raw, raw_payload,
              derived_from_observation_id::text, job_version_id::text,
              to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS published_at,
              workplace_type_raw, compensation_raw, normalized_evidence
       FROM raw_job_observations
       WHERE workspace_id = $1 AND derived_from_observation_id = $2::uuid`,
      [getContext().workspaceId, observationId],
    );
    expect(source.rows).toHaveLength(1);
    expect(source.rows[0]).toMatchObject({
      source_name: "LEVER",
      processing_status: "PROCESSED",
      derived_from_observation_id: observationId,
      description_raw: postingDescription,
      published_at: "2025-08-01T12:00:00.000Z",
      workplace_type_raw: "REMOTE",
      compensation_raw: "USD 150000-200000 per year",
    });
    expect(source.rows[0]?.raw_payload).toMatchObject({
      source_content_status: "COMPLETE",
      posting: { title: postingTitle, publishedAt: "2025-08-01T12:00:00.000Z" },
    });
    expect(source.rows[0]?.normalized_evidence).not.toBeNull();

    const original = await getClient().query<{ description_raw: string; processing_status: string }>(
      `SELECT description_raw, processing_status FROM raw_job_observations
       WHERE workspace_id = $1 AND id = $2::uuid`,
      [getContext().workspaceId, observationId],
    );
    expect(original.rows[0]).toEqual({ description_raw: "short Gmail alert snippet", processing_status: "FETCH_COMPLETE" });

    const version = await getClient().query<{
      id: string;
      description_text: string;
      source_published_at: string | null;
      job_age_days: number | null;
      freshness_basis: string | null;
      freshness_confidence: number | null;
      active_requirement_set_id: string | null;
      processing_state: string | null;
      gate_decision: string | null;
    }>(
      `SELECT version.id::text, version.description_text,
              to_char(version.source_published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS source_published_at,
              version.job_age_days, version.freshness_basis, version.freshness_confidence,
              version.active_requirement_set_id::text, canonical.processing_state, canonical.gate_decision
       FROM job_versions version
       JOIN canonical_jobs canonical ON canonical.workspace_id = version.workspace_id
         AND canonical.id = version.canonical_job_id
       WHERE version.workspace_id = $1 AND version.id = $2::uuid
         AND canonical.latest_job_version_id = version.id`,
      [getContext().workspaceId, source.rows[0]?.job_version_id],
    );
    expect(version.rows).toHaveLength(1);
    expect(version.rows[0]?.description_text).toBe(postingDescription);
    expect(version.rows[0]?.source_published_at).toBe("2025-08-01T12:00:00.000Z");
    expect(version.rows[0]?.job_age_days).toBeGreaterThan(60);
    expect(version.rows[0]?.freshness_basis).toBe("POSTED_AT");
    expect(version.rows[0]?.freshness_confidence).toBe(100);
    expect(version.rows[0]?.active_requirement_set_id).not.toBeNull();
    expect(version.rows[0]?.gate_decision).not.toBeNull();
    expect(["PREQUALIFIED", "HARD_REJECTED", "NEEDS_VERIFICATION"]).toContain(version.rows[0]?.processing_state);

    const requiredRun = await getClient().query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM requirement_extraction_runs
       WHERE workspace_id = $1 AND job_version_id = $2::uuid
         AND run_type = 'DETERMINISTIC' AND status = 'COMPLETED'`,
      [getContext().workspaceId, source.rows[0]?.job_version_id],
    );
    expect(requiredRun.rows[0]?.count).toBe(1);

    const migration = await getClient().query<{ applied: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '081_gmail_posting_retrieval_lineage.sql') AS applied`,
    );
    expect(migration.rows[0]?.applied).toBe(true);

    const secondWorkspace = await getClient().query<{ id: string }>(
      `INSERT INTO workspaces (workspace_key, display_name) VALUES ($1, 'Posting Lineage Isolation Test') RETURNING id::text AS id`,
      [`posting-isolation-${randomUUID()}`],
    );
    const crossWorkspaceId = randomUUID();
    await expect(getClient().query(
      `INSERT INTO raw_job_observations (
         id, workspace_id, source_name, company_name, title, description_raw,
         raw_payload_hash, derived_from_observation_id
       ) VALUES ($1, $2::uuid, 'LEVER', 'CFGI', $3, $4, $5, $6::uuid)`,
      [crossWorkspaceId, secondWorkspace.rows[0]?.id, postingTitle, postingDescription,
        createHash("sha256").update(crossWorkspaceId).digest("hex"), observationId],
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("blocks non-posting source text without creating a version or gate result", async () => {
    const observationId = await insertGmailObservation({
      title: "Data Governance Lead",
      url: "https://careers.example.org/jobs/data-governance-lead",
      messageId: `blocked-${randomUUID()}`,
    });
    const taskId = await enqueueFetch(observationId, `blocked-${randomUUID()}`);
    const generic = [
      "CFGI is a global company with a diverse team and collaborative culture.",
      "We offer competitive benefits, professional development, flexible programs, and opportunities to make an impact.",
      "Our values include integrity, respect, inclusion, teamwork, innovation, and service to our customers.",
      "Join our talent community to learn about future opportunities and hear from our people.",
      "We are an equal opportunity employer and welcome applicants from every background.",
      "Explore our locations, teams, stories, events, benefits, and frequently asked questions.",
      "Candidate privacy information and accommodation details are available on our careers website.",
    ].join(" ");
    const workerDependencies = dependencies(async (url, expected) => fetchJobContent(url, expected, {
      resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchOnce: async (target) => ({
        url: target.toString(),
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: Buffer.from(`<html><body><main><h1>${expected.title}</h1><p>${generic}</p></main></body></html>`),
      }),
    }));
    const result = await runBoundedStages(observationId, workerDependencies);
    expect(result.byType.FETCH_JOB_CONTENT).toMatchObject({ claimed: 1, blocked: 1 });
    const state = await getClient().query<{ task_status: string; observation_status: string; version_count: number }>(
      `SELECT task.status AS task_status, observation.processing_status AS observation_status,
              (SELECT COUNT(*)::int FROM raw_job_observations derived
               WHERE derived.workspace_id = observation.workspace_id
                 AND derived.derived_from_observation_id = observation.id) AS version_count
       FROM pipeline_tasks task
       JOIN raw_job_observations observation ON observation.workspace_id = task.workspace_id
         AND observation.id::text = task.payload->>'observation_id'
       WHERE task.id = $1`,
      [taskId],
    );
    expect(state.rows[0]).toMatchObject({ task_status: "BLOCKED_DEPENDENCY", observation_status: "FETCH_BLOCKED", version_count: 0 });
  });
});
