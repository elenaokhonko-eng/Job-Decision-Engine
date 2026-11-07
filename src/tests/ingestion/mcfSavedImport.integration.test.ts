import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadStructuredFile } from "../../config/structuredLoader.js";
import { SourcePluginSchema, type SourcePlugin } from "../../contracts/index.js";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { parseLinkedInSavedExport } from "../../ingestion/linkedInSavedExport.js";
import { importLinkedInSavedJobs, linkedInSavedImportExitCode } from "../../ingestion/linkedInSavedImport.js";
import { parseMcfSavedExport } from "../../ingestion/mcfSavedExport.js";
import { importMcfSavedJobs, mcfSavedImportExitCode } from "../../ingestion/mcfSavedImport.js";
import { completeRetrievedPostingPredicate } from "../../pipeline/descriptionQuality.js";
import { runHardGates } from "../../pipeline/hardGate.js";
import { runNormalization } from "../../pipeline/normalize.js";
import { runRequirementsExtraction } from "../../pipeline/requirementsExtractor.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { runPipelineStageTaskWorker, type PipelineStageWorkerDependencies } from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the MyCareersFuture saved-jobs import integration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
let mcfPlugin: SourcePlugin | undefined;
let linkedInPlugin: SourcePlugin | undefined;

function getClient(): pg.PoolClient {
  if (!client) throw new Error("The MCF saved-jobs integration database is not initialized.");
  return client;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("The MCF saved-jobs integration workspace is not initialized.");
  return context;
}

function plugin(value: SourcePlugin | undefined): SourcePlugin {
  if (!value) throw new Error("A source plugin manifest is not loaded.");
  return value;
}

// Synthetic fixtures only.
const COMPANY = "EXAMPLE SYNTHETIC ROBOTICS PTE. LTD.";
const DESCRIPTION = [
  "About the role: Example Synthetic Robotics is hiring an analytics engineer for its synthetic platform team.",
  "Responsibilities: you will design data models, build reporting pipelines and coordinate delivery with product squads.",
  "Requirements: experience with SQL, Python, cloud warehouses and clear written communication with stakeholders.",
].join("\n");
const PARKED_REASON = "SOURCE_RETIRED_BY_USER: LinkedIn and MyCareersFuture alert content comes from the saved-jobs export, not from fetching the page.";

function uuidHex(seed: number): string {
  return createHash("md5").update(`synthetic-mcf-${seed}`).digest("hex");
}

function mcfUrl(uuid: string): string {
  return `https://www.mycareersfuture.gov.sg/job/information-technology/synthetic-analytics-engineer-example-synthetic-robotics-${uuid}`;
}

function mcfItem(uuid: string, title: string, company = COMPANY): Record<string, unknown> {
  return {
    title,
    company,
    url: `${mcfUrl(uuid)}?source=MCF`,
    description: DESCRIPTION,
    descriptionStatus: "OK",
    location: "1 Example Street, Singapore 000001",
    salary: { min: 6500, max: 9000, currency: "SGD", period: "Monthly" },
    employmentType: "Permanent",
    postedAt: "2026-11-01",
    expiresAt: "2026-12-01",
    mcfJobUuid: uuid,
    exportedAt: "2026-11-01T00:00:00.000Z",
    sourcePage: "https://www.mycareersfuture.gov.sg/saved-jobs",
  };
}

async function importMcf(items: unknown[], dryRun = false) {
  return importMcfSavedJobs(getClient(), getContext(), parseMcfSavedExport(items), {
    dryRun,
    plugin: plugin(mcfPlugin),
    now: () => new Date("2026-11-02T00:00:00.000Z"),
  });
}

async function rowCounts(): Promise<{ observations: number; tasks: number; runs: number }> {
  const { rows } = await getClient().query<{ observations: number; tasks: number; runs: number }>(
    `SELECT (SELECT COUNT(*)::int FROM raw_job_observations WHERE workspace_id = $1) AS observations,
            (SELECT COUNT(*)::int FROM pipeline_tasks WHERE workspace_id = $1) AS tasks,
            (SELECT COUNT(*)::int FROM source_runs WHERE workspace_id = $1) AS runs`,
    [getContext().workspaceId],
  );
  const row = rows[0];
  if (!row) throw new Error("Row counts were not returned.");
  return row;
}

/**
 * A Gmail alert card in the state scripts/park_retired_alert_sources.ts leaves it:
 * task BLOCKED_DEPENDENCY on JOB_CONTENT with repair action IMPORT_SAVED_JOB_EXPORT,
 * observation FETCH_BLOCKED with an error-history entry.
 */
async function insertParkedGmailCard(sourceUrl: string, title: string, company: string): Promise<{ observationId: string; taskId: string }> {
  const observationId = randomUUID();
  const payload = { message_id: `synthetic-alert-${observationId}`, body_text: "View job" };
  await getClient().query(
    `INSERT INTO raw_job_observations (
       id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
       company_name, title, description_raw, raw_payload, raw_payload_hash, processing_status, error_history
     ) VALUES ($1, $2, 'GMAIL_ALERT', $3, $4, NOW(), $5, $6, 'short alert snippet', $7::jsonb, $8, 'FETCH_BLOCKED', $9::jsonb)`,
    [observationId, getContext().workspaceId, `gmail-${observationId}`, sourceUrl, company, title,
      JSON.stringify(payload), createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      JSON.stringify([{ stage: "FETCH_JOB_CONTENT", processing_status: "FETCH_BLOCKED", error: PARKED_REASON, occurred_at: "2026-11-01T00:00:00.000Z" }])],
  );
  const taskKey = `FETCH_JOB_CONTENT:${observationId}:posting_fetch_v1`;
  const task = await enqueuePipelineTask({
    taskType: "FETCH_JOB_CONTENT",
    taskKey,
    payload: { observation_id: observationId },
    maxAttempts: 8,
    producer: "parse_emails",
    stageVersion: "posting_fetch_v1",
    requestId: taskKey,
  }, getClient(), { context: getContext() });
  await getClient().query(
    `UPDATE pipeline_tasks
     SET status = 'BLOCKED_DEPENDENCY', blocked_on = 'JOB_CONTENT', last_error = $2,
         blocked_reason = $2, repair_action = 'IMPORT_SAVED_JOB_EXPORT'
     WHERE id = $1::uuid`,
    [task.taskId, PARKED_REASON],
  );
  return { observationId, taskId: task.taskId };
}

function workerDependencies(networkCalls: string[]): PipelineStageWorkerDependencies {
  const unusedStage = async (): Promise<never> => {
    throw new Error("A later pipeline stage was called outside the saved-export test scope.");
  };
  return {
    fetchJobContent: async (url) => {
      networkCalls.push(String(url));
      return { kind: "BLOCKED", reason: "AUTH_REQUIRED" };
    },
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

async function runFetchAndNormalize(observationId: string, networkCalls: string[], claimedBy: string) {
  return runPipelineStageTaskWorker(getClient(), {
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
    claimedBy,
  }, workerDependencies(networkCalls));
}

async function taskStatus(taskId: string): Promise<string | undefined> {
  const { rows } = await getClient().query<{ status: string }>(`SELECT status FROM pipeline_tasks WHERE id = $1::uuid`, [taskId]);
  return rows[0]?.status;
}

describe.skipIf(skipReal)("MyCareersFuture saved-jobs import (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `mcf_saved_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    mcfPlugin = (await loadStructuredFile(path.resolve(process.cwd(), "config", "source-plugins", "mcf_saved.yml"), SourcePluginSchema)).data;
    linkedInPlugin = (await loadStructuredFile(path.resolve(process.cwd(), "config", "source-plugins", "linkedin_saved.yml"), SourcePluginSchema)).data;
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("dry run validates and reports without writing anything", async () => {
    const before = await rowCounts();
    const report = await importMcf([mcfItem(uuidHex(1), "Synthetic Analytics Engineer")], true);
    expect(report.mode).toBe("DRY_RUN");
    expect(report.totals).toMatchObject({ valid: 1, staged: 1, alreadyImported: 0, gmailMatches: 0 });
    expect(report.items[0]?.outcome).toBe("WOULD_STAGE");
    expect(await rowCounts()).toEqual(before);
  });

  it("stages a new saved job through the source broker and seeds its normalization task; re-import is idempotent", async () => {
    const uuid = uuidHex(1);
    const items = [mcfItem(uuid, "Synthetic Analytics Engineer")];
    const first = await importMcf(items);
    expect(mcfSavedImportExitCode(first)).toBe(0);
    expect(first.totals).toMatchObject({ staged: 1, alreadyImported: 0, failed: 0, normalizeTasksSeeded: 1 });
    const observationId = first.items[0]?.observationId;
    expect(observationId).toBeTruthy();

    const observation = await getClient().query(
      `SELECT source_name, source_plugin_key, source_plugin_revision_id IS NOT NULL AS has_revision,
              source_external_id, source_url, location_raw, workplace_type_raw, employment_type_raw, compensation_raw,
              processing_status, raw_payload_hash ~ '^[a-f0-9]{64}$' AS hashed,
              raw_payload->>'content_provenance' AS provenance,
              raw_payload::text LIKE '%emailRecipient%' AS has_contact_field,
              normalized_evidence#>>'{availability,status}' AS availability
       FROM raw_job_observations WHERE workspace_id = $1 AND id = $2::uuid`,
      [getContext().workspaceId, observationId],
    );
    expect(observation.rows[0]).toEqual({
      source_name: "MCF_SAVED",
      source_plugin_key: "mcf_saved",
      has_revision: true,
      source_external_id: `mcf-job:${uuid}`,
      source_url: mcfUrl(uuid),
      location_raw: "1 Example Street, Singapore 000001",
      workplace_type_raw: "UNKNOWN",
      employment_type_raw: "PERMANENT",
      compensation_raw: "SGD 6,500 - 9,000 per month",
      processing_status: "PENDING",
      hashed: true,
      provenance: "MCF_SAVED_EXPORT",
      has_contact_field: false,
      availability: "UNKNOWN",
    });
    const normalizeTasks = await getClient().query<{ status: string }>(
      `SELECT status FROM pipeline_tasks
       WHERE workspace_id = $1 AND task_type = 'NORMALIZE_OBSERVATION' AND payload->>'observation_id' = $2`,
      [getContext().workspaceId, observationId],
    );
    expect(normalizeTasks.rows).toEqual([{ status: "PENDING" }]);
    const run = await getClient().query<{ status: string }>(`SELECT status FROM source_runs WHERE id = $1::uuid`, [first.sourceRunId]);
    expect(run.rows[0]?.status).toBe("COMPLETED");

    const before = await rowCounts();
    const second = await importMcf(items);
    expect(mcfSavedImportExitCode(second)).toBe(0);
    expect(second.totals).toMatchObject({ staged: 0, alreadyImported: 1, normalizeTasksSeeded: 0, normalizeTasksAlreadyQueued: 1 });
    expect(second.items[0]?.observationId).toBe(observationId);
    const after = await rowCounts();
    expect(after.observations).toBe(before.observations);
    expect(after.tasks).toBe(before.tasks);
  });

  it("revives a parked Gmail MCF alert card so its content fetch completes without a network call", async () => {
    const uuid = uuidHex(2);
    const title = "Synthetic Platform Analyst";
    // Cards staged before SES unwrapping keep the click-tracking URL; the job id is inside it.
    const wrapped = `https://abc123.r.ap-southeast-1.awstrack.me/L0/${encodeURIComponent(mcfUrl(uuid))}/1/0100-synthetic-signature`;
    const gmail = await insertParkedGmailCard(wrapped, title, "Example Synthetic Robotics");

    const dryRun = await importMcf([mcfItem(uuid, title)], true);
    expect(dryRun.items[0]?.gmailMatches).toEqual([expect.objectContaining({
      observationId: gmail.observationId,
      processingStatus: "FETCH_BLOCKED",
      outcome: "WOULD_QUEUE_CONTENT_ATTACH",
    })]);
    expect(await taskStatus(gmail.taskId)).toBe("BLOCKED_DEPENDENCY");

    const report = await importMcf([mcfItem(uuid, title)]);
    expect(mcfSavedImportExitCode(report)).toBe(0);
    expect(report.totals).toMatchObject({ gmailMatches: 1, contentAttachQueued: 1, fetchTasksReactivated: 1, fetchTasksEnqueued: 0 });
    const reactivated = await getClient().query<{ status: string; repair_action: string | null; processing_status: string }>(
      `SELECT task.status, task.repair_action, observation.processing_status
       FROM pipeline_tasks task
       JOIN raw_job_observations observation ON observation.workspace_id = task.workspace_id
        AND observation.id::text = task.payload->>'observation_id'
       WHERE task.id = $1::uuid`,
      [gmail.taskId],
    );
    expect(reactivated.rows).toEqual([{ status: "PENDING", repair_action: null, processing_status: "FETCH_PENDING" }]);

    const networkCalls: string[] = [];
    const summary = await runFetchAndNormalize(gmail.observationId, networkCalls, "mcf-saved-integration");
    expect(networkCalls).toEqual([]);
    expect(summary.byType.FETCH_JOB_CONTENT).toMatchObject({ claimed: 1, completed: 1 });
    expect(summary.byType.NORMALIZE_OBSERVATION).toMatchObject({ claimed: 1, completed: 1 });
    expect(await taskStatus(gmail.taskId)).toBe("COMPLETED");

    const derived = await getClient().query(
      `SELECT derived.source_name, derived.source_url, derived.description_raw, derived.compensation_raw,
              derived.raw_payload->>'content_provenance' AS provenance,
              derived.raw_payload->>'saved_export_observation_id' AS saved_export_observation_id,
              derived.raw_payload->>'mcf_job_uuid' AS mcf_job_uuid,
              derived.raw_payload->>'imported_at' AS imported_at,
              derived.raw_payload ? 'source_evidence' AS has_fetch_receipt,
              derived.normalized_evidence#>>'{availability,status}' AS availability,
              parent.processing_status AS parent_status,
              version.description_text AS version_description,
              canonical.canonical_url
       FROM raw_job_observations derived
       JOIN raw_job_observations parent ON parent.workspace_id = derived.workspace_id AND parent.id = derived.derived_from_observation_id
       LEFT JOIN job_versions version ON version.workspace_id = derived.workspace_id AND version.id = derived.job_version_id
       LEFT JOIN canonical_jobs canonical ON canonical.workspace_id = version.workspace_id AND canonical.id = version.canonical_job_id
       WHERE derived.workspace_id = $1 AND derived.derived_from_observation_id = $2::uuid`,
      [getContext().workspaceId, gmail.observationId],
    );
    expect(derived.rows).toEqual([{
      source_name: "MCF_SAVED",
      source_url: mcfUrl(uuid),
      description_raw: DESCRIPTION,
      compensation_raw: "SGD 6,500 - 9,000 per month",
      provenance: "MCF_SAVED_EXPORT",
      saved_export_observation_id: report.items[0]?.observationId,
      mcf_job_uuid: uuid,
      imported_at: "2026-11-02T00:00:00.000Z",
      has_fetch_receipt: false,
      availability: "UNKNOWN",
      parent_status: "PROCESSED",
      version_description: DESCRIPTION,
      canonical_url: mcfUrl(uuid),
    }]);
    const retrieved = await getClient().query<{ matches: number }>(
      `SELECT COUNT(*)::int AS matches FROM raw_job_observations derived
       WHERE derived.workspace_id = $1 AND derived.derived_from_observation_id = $2::uuid
         AND ${completeRetrievedPostingPredicate("derived")}`,
      [getContext().workspaceId, gmail.observationId],
    );
    expect(retrieved.rows[0]?.matches).toBe(1);

    // A re-import after the attach leaves the completed card alone.
    const again = await importMcf([mcfItem(uuid, title)]);
    expect(again.totals).toMatchObject({ alreadyImported: 1, gmailAlreadyComplete: 1, contentAttachQueued: 0, fetchTasksReactivated: 0 });
  });

  it("leaves a parked card blocked when the exported title differs", async () => {
    const uuid = uuidHex(3);
    const gmail = await insertParkedGmailCard(mcfUrl(uuid), "Synthetic Staff Analyst", COMPANY);
    const report = await importMcf([mcfItem(uuid, "Synthetic Principal Analyst")]);
    expect(report.items[0]?.gmailMatches).toEqual([expect.objectContaining({ observationId: gmail.observationId, outcome: "TITLE_MISMATCH" })]);
    expect(report.totals).toMatchObject({ gmailUnusable: 1, fetchTasksReactivated: 0 });
    expect(await taskStatus(gmail.taskId)).toBe("BLOCKED_DEPENDENCY");
  });

  it("stages the valid items, counts the invalid ones and fails the command", async () => {
    const good = uuidHex(4);
    const undisclosed = uuidHex(5);
    const unfetched = uuidHex(6);
    const report = await importMcf([
      mcfItem(good, "Synthetic Data Steward"),
      mcfItem(undisclosed, "Synthetic Risk Analyst", "Company Undisclosed"),
      { ...mcfItem(unfetched, "Synthetic Legacy Role"), descriptionStatus: null, description: null },
      { ...mcfItem(uuidHex(7), "Synthetic Contact Leak"), metadata: { emailRecipient: "recruiter@example.invalid" } },
    ]);
    expect(report.totals).toMatchObject({ items: 4, valid: 1, invalid: 3, staged: 1 });
    expect(report.invalid.map((entry) => entry.index)).toEqual([1, 2, 3]);
    expect(mcfSavedImportExitCode(report)).toBe(1);
    const staged = await getClient().query<{ source_external_id: string }>(
      `SELECT source_external_id FROM raw_job_observations
       WHERE workspace_id = $1 AND source_external_id = ANY($2::text[])`,
      [getContext().workspaceId, [good, undisclosed, unfetched, uuidHex(7)].map((uuid) => `mcf-job:${uuid}`)],
    );
    expect(staged.rows).toEqual([{ source_external_id: `mcf-job:${good}` }]);
    const run = await getClient().query<{ status: string; total_errors: number }>(
      `SELECT status, total_errors FROM source_runs WHERE id = $1::uuid`,
      [report.sourceRunId],
    );
    expect(run.rows[0]?.status).toBe("DEGRADED");
  });

  it("revives a LinkedIn alert card parked with IMPORT_SAVED_JOB_EXPORT from a LinkedIn saved export", async () => {
    const jobId = "4300000077";
    const title = "Synthetic Parked LinkedIn Analyst";
    const gmail = await insertParkedGmailCard(`https://www.linkedin.com/comm/jobs/view/${jobId}/?trackingId=synthetic`, title, COMPANY);
    const report = await importLinkedInSavedJobs(getClient(), getContext(), parseLinkedInSavedExport([{
      title,
      company: COMPANY,
      url: `https://www.linkedin.com/jobs/view/${jobId}/`,
      description: DESCRIPTION,
      descriptionStatus: "OK",
      location: null,
      linkedinJobId: jobId,
      exportedAt: "2026-11-01T00:00:00.000Z",
      sourcePage: "https://www.linkedin.com/my-items/saved-jobs/",
    }]), { dryRun: false, plugin: plugin(linkedInPlugin), now: () => new Date("2026-11-02T00:00:00.000Z") });
    expect(linkedInSavedImportExitCode(report)).toBe(0);
    expect(report.totals).toMatchObject({ gmailMatches: 1, contentAttachQueued: 1, fetchTasksReactivated: 1, fetchTasksEnqueued: 0 });

    const networkCalls: string[] = [];
    const summary = await runFetchAndNormalize(gmail.observationId, networkCalls, "linkedin-parked-integration");
    expect(networkCalls).toEqual([]);
    expect(summary.byType.FETCH_JOB_CONTENT).toMatchObject({ claimed: 1, completed: 1 });
    expect(await taskStatus(gmail.taskId)).toBe("COMPLETED");
    const derived = await getClient().query<{ source_name: string; provenance: string }>(
      `SELECT source_name, raw_payload->>'content_provenance' AS provenance
       FROM raw_job_observations WHERE workspace_id = $1 AND derived_from_observation_id = $2::uuid`,
      [getContext().workspaceId, gmail.observationId],
    );
    expect(derived.rows).toEqual([{ source_name: "LINKEDIN_SAVED", provenance: "LINKEDIN_SAVED_EXPORT" }]);
  });
});
