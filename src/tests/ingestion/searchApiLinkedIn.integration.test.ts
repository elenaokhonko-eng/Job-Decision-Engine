import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { fetchJobContent } from "../../ingestion/jobContentFetcher.js";
import { PgSearchApiCreditLedger, SearchApiClient, type LinkedInJobDetail } from "../../ingestion/searchApi/searchApiClient.js";
import { SourceBroker } from "../../ingestion/sourceBroker.js";
import { completeRetrievedPostingPredicate } from "../../pipeline/descriptionQuality.js";
import { runNormalization } from "../../pipeline/normalize.js";
import { runRequirementsExtraction } from "../../pipeline/requirementsExtractor.js";
import { runHardGates } from "../../pipeline/hardGate.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { runPipelineStageTaskWorker, type PipelineStageWorkerDependencies } from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run SearchAPI LinkedIn integration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let schemaPool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function getClient(): pg.PoolClient {
  if (!client) throw new Error("The SearchAPI integration test database is not initialized.");
  return client;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("The SearchAPI integration test workspace is not initialized.");
  return context;
}

function getSchemaPool(): pg.Pool {
  if (!schemaPool) throw new Error("The SearchAPI integration schema pool is not initialized.");
  return schemaPool;
}

const JOB_ID = "4100000001";
const TITLE = "Synthetic Platform Architect";
const COMPANY = "Example Data Systems";
const DESCRIPTION = [
  "About the role: Example Data Systems is hiring a platform architect for its synthetic regional data platform team.",
  "Responsibilities: you will design data platform services, review architecture decisions, and coordinate delivery with engineering squads.",
  "Requirements: experience designing cloud data platforms, strong stakeholder communication skills, and a record of production delivery.",
].join("\n");

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe.skipIf(skipReal)("SearchAPI LinkedIn source (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `searchapi_linkedin_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    const replayed = await runMigrations(client);
    if (replayed.length !== 0) throw new Error(`Migration replay unexpectedly applied: ${replayed.join(", ")}`);
    context = await resolveWorkspaceContext(client);
    schemaPool = new pg.Pool({ ...pgConnectionConfig(databaseUrl), options: `-c search_path=${schemaName},public`, max: 10 });
  }, 120_000);

  afterAll(async () => {
    await schemaPool?.end();
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("never lets concurrent reservations pass the daily credit cap", async () => {
    await getClient().query("DELETE FROM searchapi_requests");
    await getClient().query("DELETE FROM searchapi_credit_days");
    const ledger = new PgSearchApiCreditLedger(getSchemaPool());

    const reservations = await Promise.all(Array.from({ length: 20 }, (_, index) => ledger.reserve({
      engine: "linkedin_job_details",
      purpose: "DISCOVERY",
      requestKey: `linkedin_job_details:${4100000100 + index}`,
      dailyCreditCap: 5,
    })));

    expect(reservations.filter(Boolean)).toHaveLength(5);
    const counted = await getClient().query<{ credits_used: number; requests: number }>(
      `SELECT day.credits_used, (SELECT COUNT(*)::int FROM searchapi_requests) AS requests
       FROM searchapi_credit_days day`,
    );
    expect(counted.rows).toEqual([{ credits_used: 5, requests: 5 }]);
  });

  it("records each call's outcome without storing the API key", async () => {
    await getClient().query("DELETE FROM searchapi_requests");
    await getClient().query("DELETE FROM searchapi_credit_days");
    const apiKey = `integration-key-${randomUUID()}`;
    const responses = [
      jsonResponse(200, { job: { job_id: JOB_ID, title: TITLE, company_name: COMPANY, description: DESCRIPTION } }),
      jsonResponse(503, { error: "Upstream unavailable." }),
    ];
    const apiClient = new SearchApiClient({
      apiKey,
      ledger: new PgSearchApiCreditLedger(getSchemaPool()),
      dailyCreditCap: 2,
      fetchImpl: async () => responses.shift() ?? jsonResponse(500, {}),
    });

    const succeeded = await apiClient.linkedInJobDetails(JOB_ID, "CONTENT_FETCH");
    const failed = await apiClient.linkedInJobDetails("4100000002", "CONTENT_FETCH");
    const exhausted = await apiClient.linkedInJobDetails("4100000003", "CONTENT_FETCH");

    expect(succeeded.kind).toBe("OK");
    expect(failed).toMatchObject({ kind: "FAILED", httpStatus: 503, retryable: true });
    expect(exhausted.kind).toBe("BUDGET_EXHAUSTED");
    const rows = await getClient().query<{ request_key: string; purpose: string; http_status: number; outcome: string; error_detail: string | null }>(
      `SELECT request_key, purpose, http_status, outcome, error_detail FROM searchapi_requests ORDER BY requested_at, request_key`,
    );
    expect(rows.rows).toEqual([
      { request_key: `linkedin_job_details:${JOB_ID}`, purpose: "CONTENT_FETCH", http_status: 200, outcome: "SUCCEEDED", error_detail: null },
      { request_key: "linkedin_job_details:4100000002", purpose: "CONTENT_FETCH", http_status: 503, outcome: "FAILED", error_detail: "SearchAPI linkedin_job_details returned HTTP 503: Upstream unavailable." },
    ]);
    expect(JSON.stringify(rows.rows)).not.toContain(apiKey);
  });

  it("accepts LinkedIn as a manual fetch-receipt provider", async () => {
    const constraint = await getClient().query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conname = 'manual_application_fetch_receipts_provider_check'
         AND conrelid = 'manual_application_fetch_receipts'::regclass`,
    );
    expect(constraint.rows[0]?.definition).toContain("'LINKEDIN'");
  });

  it("finds LinkedIn ids already observed through alerts or settled discovery dispositions", async () => {
    const workspaceId = getContext().workspaceId;
    const alertPayload = { message_id: `alert-${randomUUID()}` };
    await getClient().query(
      `INSERT INTO raw_job_observations (
         workspace_id, source_name, source_external_id, source_url, retrieved_at,
         company_name, title, description_raw, raw_payload, raw_payload_hash, processing_status
       ) VALUES ($1, 'GMAIL_ALERT', $2, 'https://www.LinkedIn.com/comm/jobs/view/4100000011/?trk=eml', NOW(),
         $3, $4, 'alert snippet', $5::jsonb, $6, 'FETCH_PENDING')`,
      [workspaceId, `gmail-${randomUUID()}`, COMPANY, TITLE, JSON.stringify(alertPayload),
        createHash("sha256").update(JSON.stringify(alertPayload)).digest("hex")],
    );
    const broker = new SourceBroker(getClient(), getContext());
    const runId = await broker.startRun("SEARCHAPI_INTEGRATION");
    for (const [jobId, disposition] of [["4100000012", "FILTERED"], ["4100000013", "ERROR"]] as const) {
      await getClient().query(
        `INSERT INTO source_candidate_dispositions (
           workspace_id, source_run_id, source_plugin_key, plan_key, source_external_id, source_url,
           raw_payload_hash, raw_payload, disposition
         ) VALUES ($1, $2, 'searchapi_linkedin', 'feed:searchapi_linkedin:CORE_AI_DATA', $3, $4, $5, '{}'::jsonb, $6)`,
        [workspaceId, runId, `linkedin-job:${jobId}`, `https://www.linkedin.com/jobs/view/${jobId}`, "c".repeat(64), disposition],
      );
    }

    const observed = await broker.findObservedLinkedInJobIds(["4100000011", "4100000012", "4100000013", "4100000014", "not-an-id"]);

    expect([...observed].sort()).toEqual(["4100000011", "4100000012"]);
    await broker.endRun("COMPLETED");
  });

  it("completes a LinkedIn email-alert fetch with the full description and treats it as a retrieved posting", async () => {
    const workspaceId = getContext().workspaceId;
    const alertUrl = `https://www.linkedin.com/comm/jobs/view/${JOB_ID}/?trackingId=synthetic`;
    const observationId = randomUUID();
    const alertPayload = { message_id: `linkedin-alert-${observationId}`, body_text: "View job" };
    await getClient().query(
      `INSERT INTO raw_job_observations (
         id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
         company_name, title, description_raw, raw_payload, raw_payload_hash, processing_status
       ) VALUES ($1, $2, 'GMAIL_ALERT', $3, $4, NOW(), $5, $6, 'short LinkedIn alert snippet', $7::jsonb, $8, 'FETCH_PENDING')`,
      [observationId, workspaceId, `gmail-${observationId}`, alertUrl, COMPANY, TITLE, JSON.stringify(alertPayload),
        createHash("sha256").update(JSON.stringify(alertPayload)).digest("hex")],
    );
    await enqueuePipelineTask({
      taskType: "FETCH_JOB_CONTENT",
      taskKey: `FETCH_JOB_CONTENT:${observationId}:posting_fetch_v1:searchapi`,
      payload: { observation_id: observationId },
      maxAttempts: 3,
      producer: "searchapi_linkedin_integration_test",
      stageVersion: "posting_fetch_v1",
      requestId: `searchapi-${observationId}`,
    }, getClient(), { context: getContext() });

    const detail = { job_id: JOB_ID, title: TITLE, company_name: COMPANY, location: "Singapore (Hybrid)", description: DESCRIPTION } as LinkedInJobDetail;
    const linkedInCalls: string[] = [];
    const unusedStage = async (): Promise<never> => {
      throw new Error("A later pipeline stage was called outside the LinkedIn fetch test scope.");
    };
    const dependencies: PipelineStageWorkerDependencies = {
      fetchJobContent: (url, expected) => fetchJobContent(url, expected, {
        linkedInJobDetails: async (jobId) => {
          linkedInCalls.push(jobId);
          return {
            kind: "OK",
            data: detail,
            raw: { job: detail },
            evidence: {
              requestUrl: `https://www.searchapi.io/api/v1/search?engine=linkedin_job_details&job_id=${jobId}`,
              httpStatus: 200,
              retrievedAt: new Date().toISOString(),
              responseHash: "d".repeat(64),
              ledgerRequestId: randomUUID(),
            },
          };
        },
      }),
      runNormalization,
      runRequirementsExtraction,
      runHardGates,
      runEmbeddingBatchWithFallback: unusedStage as PipelineStageWorkerDependencies["runEmbeddingBatchWithFallback"],
      runLaneRouting: unusedStage as PipelineStageWorkerDependencies["runLaneRouting"],
      runDeterministicMatcher: unusedStage as PipelineStageWorkerDependencies["runDeterministicMatcher"],
      runRecommendationDecider: unusedStage as PipelineStageWorkerDependencies["runRecommendationDecider"],
      runExplanationQueueEnqueuer: unusedStage as PipelineStageWorkerDependencies["runExplanationQueueEnqueuer"],
    };

    const summary = await runPipelineStageTaskWorker(getClient(), {
      context: getContext(),
      seed: false,
      reconcileStalePending: false,
      observationIds: [observationId],
      taskTypes: ["FETCH_JOB_CONTENT", "NORMALIZE_OBSERVATION"],
      maxTasks: 2,
      maxTasksByType: { FETCH_JOB_CONTENT: 1, NORMALIZE_OBSERVATION: 1 },
      stageQuantum: 1,
      claimBatchSize: 1,
      wallClockMs: 30_000,
      minTimeToStartTaskMs: 0,
      heartbeatSeconds: 0,
      claimedBy: "searchapi-linkedin-integration",
    }, dependencies);

    expect(linkedInCalls).toEqual([JOB_ID]);
    expect(summary.byType.FETCH_JOB_CONTENT).toMatchObject({ claimed: 1, completed: 1 });
    expect(summary.byType.NORMALIZE_OBSERVATION).toMatchObject({ claimed: 1, completed: 1 });
    const derived = await getClient().query<{
      source_name: string;
      source_url: string;
      description_raw: string;
      workplace_type_raw: string;
      parent_status: string;
      version_description: string | null;
    }>(
      `SELECT derived.source_name, derived.source_url, derived.description_raw, derived.workplace_type_raw,
              parent.processing_status AS parent_status, version.description_text AS version_description
       FROM raw_job_observations derived
       JOIN raw_job_observations parent ON parent.workspace_id = derived.workspace_id AND parent.id = derived.derived_from_observation_id
       LEFT JOIN job_versions version ON version.workspace_id = derived.workspace_id AND version.id = derived.job_version_id
       WHERE derived.workspace_id = $1 AND derived.derived_from_observation_id = $2::uuid`,
      [workspaceId, observationId],
    );
    expect(derived.rows).toEqual([{
      source_name: "LINKEDIN",
      source_url: `https://www.linkedin.com/jobs/view/${JOB_ID}`,
      description_raw: DESCRIPTION,
      workplace_type_raw: "HYBRID",
      parent_status: "PROCESSED",
      version_description: DESCRIPTION,
    }]);
    const retrieved = await getClient().query<{ matches: number }>(
      `SELECT COUNT(*)::int AS matches FROM raw_job_observations derived
       WHERE derived.workspace_id = $1 AND derived.derived_from_observation_id = $2::uuid
         AND ${completeRetrievedPostingPredicate("derived")}`,
      [workspaceId, observationId],
    );
    expect(retrieved.rows[0]?.matches).toBe(1);
  });
});
