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
  throw new Error("CI must run the LinkedIn saved-jobs import integration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
let plugin: SourcePlugin | undefined;

function getClient(): pg.PoolClient {
  if (!client) throw new Error("The LinkedIn saved-jobs integration database is not initialized.");
  return client;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("The LinkedIn saved-jobs integration workspace is not initialized.");
  return context;
}

function getPlugin(): SourcePlugin {
  if (!plugin) throw new Error("The linkedin_saved plugin manifest is not loaded.");
  return plugin;
}

// Synthetic fixtures only.
const DESCRIPTION = [
  "About the role: Example Synthetic Robotics is hiring an analytics engineer for its synthetic platform team.",
  "Responsibilities: you will design data models, build reporting pipelines and coordinate delivery with product squads.",
  "Requirements: experience with SQL, Python, cloud warehouses and clear written communication with stakeholders.",
].join("\n");

function savedItem(jobId: string, title: string, company = "Example Synthetic Robotics"): Record<string, unknown> {
  return {
    title,
    company,
    url: `https://www.linkedin.com/jobs/view/${jobId}/`,
    description: DESCRIPTION,
    descriptionStatus: "OK",
    location: null,
    linkedinJobId: jobId,
    exportedAt: "2026-11-01T00:00:00.000Z",
    sourcePage: "https://www.linkedin.com/my-items/saved-jobs/",
  };
}

async function importItems(items: unknown[], dryRun = false) {
  return importLinkedInSavedJobs(getClient(), getContext(), parseLinkedInSavedExport(items), {
    dryRun,
    plugin: getPlugin(),
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

async function insertBlockedGmailCard(jobId: string, title: string, company: string): Promise<{ observationId: string; taskId: string }> {
  const observationId = randomUUID();
  const payload = { message_id: `synthetic-alert-${observationId}`, body_text: "View job" };
  await getClient().query(
    `INSERT INTO raw_job_observations (
       id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
       company_name, title, description_raw, raw_payload, raw_payload_hash, processing_status
     ) VALUES ($1, $2, 'GMAIL_ALERT', $3, $4, NOW(), $5, $6, 'short LinkedIn alert snippet', $7::jsonb, $8, 'FETCH_BLOCKED')`,
    [observationId, getContext().workspaceId, `gmail-${observationId}`, `https://www.linkedin.com/comm/jobs/view/${jobId}/?trackingId=synthetic`,
      company, title, JSON.stringify(payload), createHash("sha256").update(JSON.stringify(payload)).digest("hex")],
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
  // The state production reaches when a LinkedIn page needs sign-in.
  await getClient().query(
    `UPDATE pipeline_tasks
     SET status = 'BLOCKED_DEPENDENCY', blocked_on = 'JOB_CONTENT',
         repair_action = 'PROVIDE_EMPLOYER_URL_OR_FULL_JD',
         blocked_reason = 'POSTING_CONTENT_BLOCKED: AUTH_REQUIRED', attempt_count = 1
     WHERE id = $1::uuid`,
    [task.taskId],
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

describe.skipIf(skipReal)("LinkedIn saved-jobs import (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `linkedin_saved_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    plugin = (await loadStructuredFile(
      path.resolve(process.cwd(), "config", "source-plugins", "linkedin_saved.yml"),
      SourcePluginSchema,
    )).data;
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("dry run validates and reports matches without writing anything", async () => {
    const before = await rowCounts();
    const report = await importItems([savedItem("4300000001", "Synthetic Analytics Engineer")], true);
    expect(report.mode).toBe("DRY_RUN");
    expect(report.totals).toMatchObject({ valid: 1, staged: 1, alreadyImported: 0, gmailMatches: 0 });
    expect(report.items[0]?.outcome).toBe("WOULD_STAGE");
    expect(await rowCounts()).toEqual(before);
  });

  it("stages a new saved job through the source broker and seeds its normalization task; re-import is idempotent", async () => {
    const items = [savedItem("4300000001", "Synthetic Analytics Engineer")];
    const first = await importItems(items);
    expect(linkedInSavedImportExitCode(first)).toBe(0);
    expect(first.totals).toMatchObject({ staged: 1, alreadyImported: 0, failed: 0, normalizeTasksSeeded: 1 });
    const observationId = first.items[0]?.observationId;
    expect(observationId).toBeTruthy();

    const observation = await getClient().query(
      `SELECT source_name, source_plugin_key, source_plugin_revision_id IS NOT NULL AS has_revision,
              source_external_id, source_url, location_raw, workplace_type_raw, compensation_raw,
              processing_status, raw_payload_hash ~ '^[a-f0-9]{64}$' AS hashed,
              raw_payload->>'content_provenance' AS provenance,
              normalized_evidence#>>'{availability,status}' AS availability
       FROM raw_job_observations WHERE workspace_id = $1 AND id = $2::uuid`,
      [getContext().workspaceId, observationId],
    );
    expect(observation.rows[0]).toEqual({
      source_name: "LINKEDIN_SAVED",
      source_plugin_key: "linkedin_saved",
      has_revision: true,
      source_external_id: "linkedin-job:4300000001",
      source_url: "https://www.linkedin.com/jobs/view/4300000001",
      location_raw: null,
      workplace_type_raw: "UNKNOWN",
      compensation_raw: null,
      processing_status: "PENDING",
      hashed: true,
      provenance: "LINKEDIN_SAVED_EXPORT",
      availability: "UNKNOWN",
    });
    const normalizeTasks = await getClient().query<{ status: string }>(
      `SELECT status FROM pipeline_tasks
       WHERE workspace_id = $1 AND task_type = 'NORMALIZE_OBSERVATION' AND payload->>'observation_id' = $2`,
      [getContext().workspaceId, observationId],
    );
    expect(normalizeTasks.rows).toEqual([{ status: "PENDING" }]);

    const before = await rowCounts();
    const second = await importItems(items);
    expect(linkedInSavedImportExitCode(second)).toBe(0);
    expect(second.totals).toMatchObject({ staged: 0, alreadyImported: 1, normalizeTasksSeeded: 0, normalizeTasksAlreadyQueued: 1 });
    expect(second.items[0]?.observationId).toBe(observationId);
    const after = await rowCounts();
    expect(after.observations).toBe(before.observations);
    expect(after.tasks).toBe(before.tasks);
  });

  it("attaches the export to a blocked Gmail LinkedIn card so its content fetch completes without a network call", async () => {
    const jobId = "4300000002";
    const title = "Synthetic Platform Analyst";
    const company = "Example Synthetic Robotics";
    const gmail = await insertBlockedGmailCard(jobId, title, company);

    const dryRun = await importItems([savedItem(jobId, title)], true);
    expect(dryRun.items[0]?.gmailMatches).toEqual([expect.objectContaining({
      observationId: gmail.observationId,
      outcome: "WOULD_QUEUE_CONTENT_ATTACH",
    })]);

    const report = await importItems([savedItem(jobId, title)]);
    expect(linkedInSavedImportExitCode(report)).toBe(0);
    expect(report.totals).toMatchObject({ gmailMatches: 1, contentAttachQueued: 1, fetchTasksReactivated: 1, fetchTasksEnqueued: 0 });
    const reactivated = await getClient().query<{ status: string; processing_status: string }>(
      `SELECT task.status, observation.processing_status
       FROM pipeline_tasks task
       JOIN raw_job_observations observation ON observation.workspace_id = task.workspace_id
        AND observation.id::text = task.payload->>'observation_id'
       WHERE task.id = $1::uuid`,
      [gmail.taskId],
    );
    expect(reactivated.rows).toEqual([{ status: "PENDING", processing_status: "FETCH_PENDING" }]);

    const networkCalls: string[] = [];
    const summary = await runPipelineStageTaskWorker(getClient(), {
      context: getContext(),
      seed: false,
      reconcileStalePending: false,
      observationIds: [gmail.observationId],
      taskTypes: ["FETCH_JOB_CONTENT", "NORMALIZE_OBSERVATION"],
      maxTasks: 2,
      maxTasksByType: { FETCH_JOB_CONTENT: 1, NORMALIZE_OBSERVATION: 1 },
      stageQuantum: 1,
      claimBatchSize: 1,
      wallClockMs: 30_000,
      minTimeToStartTaskMs: 0,
      heartbeatSeconds: 0,
      claimedBy: "linkedin-saved-integration",
    }, workerDependencies(networkCalls));

    expect(networkCalls).toEqual([]);
    expect(summary.byType.FETCH_JOB_CONTENT).toMatchObject({ claimed: 1, completed: 1 });
    expect(summary.byType.NORMALIZE_OBSERVATION).toMatchObject({ claimed: 1, completed: 1 });
    const task = await getClient().query<{ status: string }>(`SELECT status FROM pipeline_tasks WHERE id = $1::uuid`, [gmail.taskId]);
    expect(task.rows[0]?.status).toBe("COMPLETED");

    const derived = await getClient().query(
      `SELECT derived.source_name, derived.source_url, derived.description_raw,
              derived.raw_payload->>'content_provenance' AS provenance,
              derived.raw_payload->>'saved_export_observation_id' AS saved_export_observation_id,
              derived.raw_payload->>'imported_at' AS imported_at,
              derived.raw_payload->>'content_hash' ~ '^[a-f0-9]{64}$' AS has_content_hash,
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
      source_name: "LINKEDIN_SAVED",
      source_url: `https://www.linkedin.com/jobs/view/${jobId}`,
      description_raw: DESCRIPTION,
      provenance: "LINKEDIN_SAVED_EXPORT",
      saved_export_observation_id: report.items[0]?.observationId,
      imported_at: "2026-11-02T00:00:00.000Z",
      has_content_hash: true,
      has_fetch_receipt: false,
      availability: "UNKNOWN",
      parent_status: "PROCESSED",
      version_description: DESCRIPTION,
      canonical_url: `https://www.linkedin.com/jobs/view/${jobId}`,
    }]);
    const retrieved = await getClient().query<{ matches: number }>(
      `SELECT COUNT(*)::int AS matches FROM raw_job_observations derived
       WHERE derived.workspace_id = $1 AND derived.derived_from_observation_id = $2::uuid
         AND ${completeRetrievedPostingPredicate("derived")}`,
      [getContext().workspaceId, gmail.observationId],
    );
    expect(retrieved.rows[0]?.matches).toBe(1);

    // Normalizing the saved observation itself joins the same canonical job.
    const savedObservationId = report.items[0]?.observationId;
    if (!savedObservationId) throw new Error("The saved observation id was not reported.");
    const normalized = await runNormalization(getClient(), { observationIds: [savedObservationId], context: getContext() });
    expect(normalized.totalErrors).toBe(0);
    const canonicalJobs = await getClient().query<{ count: number }>(
      `SELECT COUNT(DISTINCT version.canonical_job_id)::int AS count
       FROM raw_job_observations observation
       JOIN job_versions version ON version.workspace_id = observation.workspace_id AND version.id = observation.job_version_id
       WHERE observation.workspace_id = $1 AND observation.source_external_id = $2`,
      [getContext().workspaceId, `linkedin-job:${jobId}`],
    );
    expect(canonicalJobs.rows[0]?.count).toBe(1);

    // A re-import after the attach leaves the completed card alone.
    const again = await importItems([savedItem(jobId, title)]);
    expect(again.totals).toMatchObject({ alreadyImported: 1, gmailAlreadyComplete: 1, contentAttachQueued: 0, fetchTasksReactivated: 0 });
  });

  it("does not attach an export whose title differs from the Gmail card", async () => {
    const gmail = await insertBlockedGmailCard("4300000003", "Synthetic Staff Analyst", "Example Synthetic Robotics");
    const report = await importItems([savedItem("4300000003", "Synthetic Principal Analyst")]);
    expect(report.items[0]?.gmailMatches).toEqual([expect.objectContaining({ observationId: gmail.observationId, outcome: "TITLE_MISMATCH" })]);
    const task = await getClient().query<{ status: string }>(`SELECT status FROM pipeline_tasks WHERE id = $1::uuid`, [gmail.taskId]);
    expect(task.rows[0]?.status).toBe("BLOCKED_DEPENDENCY");
  });

  it("stages the valid items, counts the invalid ones and fails the command", async () => {
    const report = await importItems([
      savedItem("4300000004", "Synthetic Data Steward"),
      { ...savedItem("4300000005", "Synthetic Risk Analyst"), company: "Unknown Company" },
      { title: "Synthetic Legacy Role", company: "Example Synthetic Robotics", url: "https://www.linkedin.com/jobs/view/4300000006/", location: "Singapore", description: "Failed to fetch description automatically." },
    ]);
    expect(report.totals).toMatchObject({ items: 3, valid: 1, invalid: 2, staged: 1 });
    expect(report.invalid.map((entry) => entry.index)).toEqual([1, 2]);
    expect(linkedInSavedImportExitCode(report)).toBe(1);
    const staged = await getClient().query<{ source_external_id: string }>(
      `SELECT source_external_id FROM raw_job_observations
       WHERE workspace_id = $1 AND source_external_id IN ('linkedin-job:4300000004', 'linkedin-job:4300000005', 'linkedin-job:4300000006')`,
      [getContext().workspaceId],
    );
    expect(staged.rows).toEqual([{ source_external_id: "linkedin-job:4300000004" }]);
    const run = await getClient().query<{ status: string; total_errors: number }>(
      `SELECT status, total_errors FROM source_runs WHERE id = $1::uuid`,
      [report.sourceRunId],
    );
    expect(run.rows[0]?.status).toBe("DEGRADED");
  });
});
