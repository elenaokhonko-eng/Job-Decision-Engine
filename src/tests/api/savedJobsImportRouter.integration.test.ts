import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiV2Router } from "../../api/v2/router.js";
import { SAVED_IMPORT_MAX_BODY_BYTES, SAVED_IMPORT_MAX_ITEMS } from "../../api/v2/savedJobsImportRouter.js";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the saved-jobs import API integration tests against its PostgreSQL service.");
}

const TOKEN = "synthetic-saved-import-test-token";
// Synthetic fixtures only.
const DESCRIPTION = [
  "About the role: Example Synthetic Robotics is hiring an analytics engineer for its synthetic platform team.",
  "Responsibilities: you will design data models, build reporting pipelines and coordinate delivery with product squads.",
  "Requirements: experience with SQL, Python, cloud warehouses and clear written communication with stakeholders.",
].join("\n");
const MCF_COMPANY = "EXAMPLE SYNTHETIC ROBOTICS PTE. LTD.";
const MCF_TITLE = "Synthetic Analytics Engineer";

function linkedInItem(jobId: string, title = "Synthetic Analytics Engineer"): Record<string, unknown> {
  return {
    title,
    company: "Example Synthetic Robotics",
    url: `https://www.linkedin.com/jobs/view/${jobId}/`,
    description: DESCRIPTION,
    descriptionStatus: "OK",
    location: null,
    linkedinJobId: jobId,
    exportedAt: "2026-11-01T00:00:00.000Z",
    sourcePage: "https://www.linkedin.com/my-items/saved-jobs/",
  };
}

function mcfUuid(seed: number): string {
  return createHash("md5").update(`synthetic-mcf-api-${seed}`).digest("hex");
}

function mcfUrl(uuid: string): string {
  return `https://www.mycareersfuture.gov.sg/job/information-technology/synthetic-analytics-engineer-example-synthetic-robotics-${uuid}`;
}

function mcfItem(uuid: string): Record<string, unknown> {
  return {
    title: MCF_TITLE,
    company: MCF_COMPANY,
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

let pool: pg.Pool | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
let server: Server | undefined;
let readerServer: Server | undefined;
let previousToken: string | undefined;

function getPool(): pg.Pool {
  if (!pool) throw new Error("The saved-jobs import API database is not initialized.");
  return pool;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("The saved-jobs import API workspace is not initialized.");
  return context;
}

function baseUrl(target: Server | undefined): string {
  if (!target) throw new Error("The test API server is not running.");
  return `http://127.0.0.1:${(target.address() as AddressInfo).port}/api/v2`;
}

async function startServer(resolveAs: () => WorkspaceContext): Promise<Server> {
  const app = express();
  app.use("/api/v2", createApiV2Router({ pool: getPool(), resolveContext: async () => resolveAs() }));
  const started = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => started.once("listening", resolve));
  return started;
}

async function post(path: string, body: unknown, options: { token?: string | null; target?: Server; rawBody?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = options.token === undefined ? TOKEN : options.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl(options.target ?? server)}${path}`, {
    method: "POST",
    headers,
    body: options.rawBody ?? JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function rowCounts(): Promise<{ observations: number; tasks: number; runs: number }> {
  const { rows } = await getPool().query<{ observations: number; tasks: number; runs: number }>(
    `SELECT (SELECT COUNT(*)::int FROM raw_job_observations WHERE workspace_id = $1) AS observations,
            (SELECT COUNT(*)::int FROM pipeline_tasks WHERE workspace_id = $1) AS tasks,
            (SELECT COUNT(*)::int FROM source_runs WHERE workspace_id = $1) AS runs`,
    [getContext().workspaceId],
  );
  const row = rows[0];
  if (!row) throw new Error("Row counts were not returned.");
  return row;
}

/** A Gmail MCF alert card parked for a saved-job export (see scripts/park_retired_alert_sources.ts). */
async function insertParkedGmailCard(uuid: string): Promise<{ observationId: string; taskId: string }> {
  const client = await getPool().connect();
  try {
    const observationId = randomUUID();
    const payload = { message_id: `synthetic-alert-${observationId}`, body_text: "View job" };
    await client.query(
      `INSERT INTO raw_job_observations (
         id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
         company_name, title, description_raw, raw_payload, raw_payload_hash, processing_status
       ) VALUES ($1, $2, 'GMAIL_ALERT', $3, $4, NOW(), $5, $6, 'short alert snippet', $7::jsonb, $8, 'FETCH_BLOCKED')`,
      [observationId, getContext().workspaceId, `gmail-${observationId}`, mcfUrl(uuid), MCF_COMPANY, MCF_TITLE,
        JSON.stringify(payload), createHash("sha256").update(JSON.stringify(payload)).digest("hex")],
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
    }, client, { context: getContext() });
    await client.query(
      `UPDATE pipeline_tasks
       SET status = 'BLOCKED_DEPENDENCY', blocked_on = 'JOB_CONTENT', last_error = 'SOURCE_RETIRED_BY_USER',
           blocked_reason = 'SOURCE_RETIRED_BY_USER', repair_action = 'IMPORT_SAVED_JOB_EXPORT'
       WHERE id = $1::uuid`,
      [task.taskId],
    );
    return { observationId, taskId: task.taskId };
  } finally {
    client.release();
  }
}

describe.skipIf(skipReal)("saved-jobs import API (PostgreSQL)", () => {
  beforeAll(async () => {
    previousToken = process.env.JDEC_API_TOKEN;
    process.env.JDEC_API_TOKEN = TOKEN;
    schemaName = `saved_import_api_${randomUUID().replaceAll("-", "")}`;
    const setup = new pg.Client(pgConnectionConfig(databaseUrl));
    await setup.connect();
    try {
      await setup.query(`CREATE SCHEMA ${schemaName}`);
      await setup.query(`SET search_path TO ${schemaName}, public`);
      await runMigrations(setup);
    } finally {
      await setup.end();
    }
    pool = new pg.Pool({ ...pgConnectionConfig(databaseUrl), options: `-c search_path=${schemaName},public` });
    context = await resolveWorkspaceContext(pool);
    server = await startServer(getContext);
    readerServer = await startServer(() => ({ ...getContext(), role: "READER" }));
  }, 120_000);

  afterAll(async () => {
    if (previousToken === undefined) delete process.env.JDEC_API_TOKEN;
    else process.env.JDEC_API_TOKEN = previousToken;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (readerServer ? readerServer.close(() => resolve()) : resolve()));
    if (pool) {
      if (schemaName) await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await pool.end();
    }
  });

  it("requires the API bearer token on both import routes and the retired route", async () => {
    for (const path of ["/imports/linkedin-saved", "/imports/mcf-saved", "/observations/linkedin"]) {
      const missing = await post(path, { items: [linkedInItem("4300000001")], dryRun: true }, { token: null });
      expect(missing.status).toBe(401);
      const wrong = await post(path, { items: [linkedInItem("4300000001")], dryRun: true }, { token: "wrong-token" });
      expect(wrong.status).toBe(401);
    }
  });

  it("rejects a read-only workspace role", async () => {
    const before = await rowCounts();
    const response = await post("/imports/linkedin-saved", { items: [linkedInItem("4300000001")], dryRun: false }, { target: readerServer });
    expect(response.status).toBe(403);
    expect(await rowCounts()).toEqual(before);
  });

  it("dry run validates, reports invalid items with index and reason, and writes nothing", async () => {
    const before = await rowCounts();
    const invalid = { ...linkedInItem("4300000002"), company: "Unknown Company" };
    const response = await post("/imports/linkedin-saved", { items: [linkedInItem("4300000001"), invalid], dryRun: true });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      schema_version: "saved_jobs_import_v1",
      source: "LINKEDIN_SAVED",
      mode: "DRY_RUN",
      complete: false,
      source_run_id: null,
    });
    expect(response.body.totals).toMatchObject({ items: 2, valid: 1, invalid: 1, staged: 1, alreadyImported: 0 });
    expect(response.body.invalid).toEqual([{ index: 1, reason: expect.stringContaining("company is missing") }]);
    expect(response.body.items).toEqual([expect.objectContaining({ index: 0, job_id: "4300000001", outcome: "WOULD_STAGE" })]);
    expect(await rowCounts()).toEqual(before);
  });

  it("imports through the canonical LinkedIn importer, returns ids and counts only, and is idempotent", async () => {
    const items = [linkedInItem("4300000001")];
    const first = await post("/imports/linkedin-saved", { items, dryRun: false });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, mode: "APPLIED", complete: true });
    expect(first.body.totals).toMatchObject({ valid: 1, invalid: 0, staged: 1, alreadyImported: 0, failed: 0, normalizeTasksSeeded: 1 });
    const observationId = first.body.items[0]?.observation_id as string;
    expect(first.body.items[0]).toMatchObject({ job_id: "4300000001", outcome: "NEW" });
    const serialized = JSON.stringify(first.body);
    expect(serialized).not.toContain("Example Synthetic Robotics");
    expect(serialized).not.toContain("Synthetic Analytics Engineer");
    expect(serialized).not.toContain("design data models");

    const { rows } = await getPool().query<{ source_name: string; source_external_id: string; processing_status: string; location_raw: string | null }>(
      `SELECT source_name, source_external_id, processing_status, location_raw FROM raw_job_observations WHERE id = $1::uuid`,
      [observationId],
    );
    expect(rows).toEqual([{ source_name: "LINKEDIN_SAVED", source_external_id: "linkedin-job:4300000001", processing_status: "PENDING", location_raw: null }]);

    const before = await rowCounts();
    const second = await post("/imports/linkedin-saved", { items, dryRun: false });
    expect(second.body.totals).toMatchObject({ staged: 0, alreadyImported: 1 });
    expect(second.body.items[0]).toMatchObject({ outcome: "ALREADY_IMPORTED", observation_id: observationId });
    expect((await rowCounts()).observations).toBe(before.observations);

    const dryAgain = await post("/imports/linkedin-saved", { items, dryRun: true });
    expect(dryAgain.body.items[0]).toMatchObject({ outcome: "WOULD_SKIP_ALREADY_IMPORTED", observation_id: observationId });
  });

  it("imports MCF saved jobs and revives a parked Gmail alert card", async () => {
    const uuid = mcfUuid(1);
    const card = await insertParkedGmailCard(uuid);

    const before = await rowCounts();
    const dry = await post("/imports/mcf-saved", { items: [mcfItem(uuid)], dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.totals).toMatchObject({ staged: 1, gmailMatches: 1, contentAttachQueued: 1 });
    expect(dry.body.items[0].gmail_matches).toEqual([expect.objectContaining({ observation_id: card.observationId, outcome: "WOULD_QUEUE_CONTENT_ATTACH" })]);
    expect(await rowCounts()).toEqual(before);

    const applied = await post("/imports/mcf-saved", { items: [mcfItem(uuid)], dryRun: false });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ source: "MCF_SAVED", mode: "APPLIED", complete: true });
    expect(applied.body.totals).toMatchObject({ staged: 1, contentAttachQueued: 1, fetchTasksReactivated: 1 });
    expect(applied.body.items[0]).toMatchObject({ job_id: uuid, outcome: "NEW" });
    expect(applied.body.items[0].gmail_matches).toEqual([
      expect.objectContaining({ observation_id: card.observationId, outcome: "CONTENT_ATTACH_QUEUED", fetch_tasks_reactivated: 1 }),
    ]);
    const task = await getPool().query<{ status: string }>(`SELECT status FROM pipeline_tasks WHERE id = $1::uuid`, [card.taskId]);
    expect(task.rows).toEqual([{ status: "PENDING" }]);
    expect(JSON.stringify(applied.body)).not.toContain(MCF_COMPANY);
  });

  it("rejects malformed requests and file-level export errors without writing", async () => {
    const before = await rowCounts();
    const missingFlag = await post("/imports/mcf-saved", { items: [mcfItem(mcfUuid(2))] });
    expect(missingFlag.status).toBe(400);
    expect(missingFlag.body.error).toBe("INVALID_REQUEST");
    const notArray = await post("/imports/mcf-saved", { items: { title: "x" }, dryRun: true });
    expect(notArray.status).toBe(400);
    const empty = await post("/imports/linkedin-saved", { items: [], dryRun: false });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("INVALID_EXPORT");
    const badJson = await post("/imports/linkedin-saved", null, { rawBody: "{not json" });
    expect(badJson.status).toBe(400);
    expect(badJson.body.error).toBe("INVALID_JSON");
    expect(await rowCounts()).toEqual(before);
  });

  it("enforces the item-count and body-size limits", async () => {
    const before = await rowCounts();
    const tooMany = Array.from({ length: SAVED_IMPORT_MAX_ITEMS + 1 }, (_, index) => ({ linkedinJobId: String(5000000000 + index) }));
    const countResponse = await post("/imports/linkedin-saved", { items: tooMany, dryRun: false });
    expect(countResponse.status).toBe(413);
    expect(countResponse.body).toMatchObject({ ok: false, error: "TOO_MANY_ITEMS", limit: SAVED_IMPORT_MAX_ITEMS });

    const oversized = { items: [{ ...linkedInItem("4300000009"), description: "x".repeat(SAVED_IMPORT_MAX_BODY_BYTES + 1) }], dryRun: false };
    const sizeResponse = await post("/imports/linkedin-saved", oversized);
    expect(sizeResponse.status).toBe(413);
    expect(sizeResponse.body).toMatchObject({ ok: false, error: "PAYLOAD_TOO_LARGE" });
    expect(await rowCounts()).toEqual(before);
  });

  it("keeps the 1 MB limit on other v2 routes", async () => {
    const large = await post("/observations/manual", { title: "t", company: "c", description: "x".repeat(1024 * 1024 + 10) });
    expect(large.status).not.toBe(200);
    expect(large.body.ok).toBe(false);
  });

  it("retires the legacy LinkedIn observations route with 410 and writes nothing", async () => {
    const before = await rowCounts();
    const response = await post("/observations/linkedin", {
      jobs: [{ title: "Synthetic Role", company: "Example Co", url: "https://www.linkedin.com/jobs/view/4300000003/", description: DESCRIPTION }],
    });
    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({ ok: false, error: "GONE", replacement: "/api/v2/imports/linkedin-saved" });
    expect(await rowCounts()).toEqual(before);
  });
});
