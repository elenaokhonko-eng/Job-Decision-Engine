import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiV2Router } from "../../api/v2/router.js";
import { JobConfirmedFactResponseSchema, JobConfirmedFactsListResponseSchema } from "../../contracts/jobConfirmedFacts.js";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the confirmed-fact API integration tests against its PostgreSQL service.");
}

const TOKEN = "synthetic-confirmed-fact-test-token";

let pool: pg.Pool | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
let server: Server | undefined;
let readerServer: Server | undefined;
let previousToken: string | undefined;
let canonicalJobId = "";
let jobVersionId = "";
let staleVersionId = "";

function getPool(): pg.Pool {
  if (!pool) throw new Error("The confirmed-fact API database is not initialized.");
  return pool;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("The confirmed-fact API workspace is not initialized.");
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

async function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  options: { token?: string | null; target?: Server } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = options.token === undefined ? TOKEN : options.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl(options.target ?? server)}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

function factBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_version_id: jobVersionId,
    fact_type: "OFFICE_DAYS",
    value: { office_days_min: 2, office_days_max: 2 },
    source_type: "RECRUITER_EMAIL",
    source_note: "Recruiter confirmed by email",
    source_url: "https://careers.example.test/confirmed-api/role",
    ...overrides,
  };
}

describe.skipIf(skipReal)("confirmed-fact API (PostgreSQL)", () => {
  beforeAll(async () => {
    previousToken = process.env.JDEC_API_TOKEN;
    process.env.JDEC_API_TOKEN = TOKEN;
    schemaName = `confirmed_fact_api_${randomUUID().replaceAll("-", "")}`;
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

    const job = await pool.query<{ id: string }>(
      `INSERT INTO canonical_jobs (
         workspace_id, company_name, normalized_title, canonical_url, location, workplace_type,
         processing_state, processing_status, gate_decision
       ) VALUES ($1, 'Synthetic Confirmed API Co', 'Synthetic Data Engineer', 'https://example.test/confirmed-api',
                 'Singapore', 'HYBRID', 'MATCHED', 'MATCHED', 'NEEDS_VERIFICATION')
       RETURNING id`,
      [getContext().workspaceId],
    );
    canonicalJobId = job.rows[0].id;
    const stale = await pool.query<{ id: string }>(
      `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at)
       VALUES ($1, $2, 1, 'confirmed-api-v1', 'Synthetic data engineering role, first posting.', NOW() - INTERVAL '2 days')
       RETURNING id`,
      [getContext().workspaceId, canonicalJobId],
    );
    staleVersionId = stale.rows[0].id;
    const current = await pool.query<{ id: string }>(
      `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at)
       VALUES ($1, $2, 2, 'confirmed-api-v2', 'Synthetic data engineering role, hybrid working.', NOW())
       RETURNING id`,
      [getContext().workspaceId, canonicalJobId],
    );
    jobVersionId = current.rows[0].id;
    await pool.query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [jobVersionId, canonicalJobId]);
    await pool.query(
      `INSERT INTO gate_decisions (
         workspace_id, canonical_job_id, job_version_id, gate_version, decision,
         rejection_codes, evidence_quotes, workability_facts
       ) VALUES ($1, $2, $3, 'fixture', 'NEEDS_VERIFICATION',
                 '["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_OFFICE_DAYS"]'::jsonb,
                 '["Hybrid arrangement listed without explicit office-day count"]'::jsonb,
                 '{"office_days_min": null, "office_days_max": null, "travel_pct_max": null, "employment_type": "UNKNOWN", "location_restriction": null}'::jsonb)`,
      [getContext().workspaceId, canonicalJobId, jobVersionId],
    );

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

  it("requires the bearer token and a writable role", async () => {
    const path = `/jobs/${canonicalJobId}/confirmed-facts`;
    expect((await call("POST", path, factBody(), { token: null })).status).toBe(401);
    expect((await call("GET", path, undefined, { token: "wrong" })).status).toBe(401);
    const reader = await call("POST", path, factBody(), { target: readerServer });
    expect(reader.status).toBe(403);
    expect(reader.body.error).toBe("FORBIDDEN");
  });

  it("shows the open office-day check and the gate's workability facts before any confirmation", async () => {
    const response = await call("GET", `/jobs/${canonicalJobId}/confirmed-facts`);
    expect(response.status).toBe(200);
    const parsed = JobConfirmedFactsListResponseSchema.parse(response.body);
    expect(parsed.checks).toMatchObject({
      canonical_job_id: canonicalJobId,
      job_version_id: jobVersionId,
      gate_decision: "NEEDS_VERIFICATION",
      open_checks: ["OFFICE_DAYS"],
      confirmed_facts: [],
      rerun_pending: false,
    });
    expect(parsed.checks?.gate_workability_facts).toMatchObject({ office_days_max: null });
    expect(parsed.history).toEqual([]);
  });

  it("validates the body and the job identity", async () => {
    const path = `/jobs/${canonicalJobId}/confirmed-facts`;
    for (const body of [
      factBody({ value: { office_days_min: 4, office_days_max: 1 } }),
      factBody({ fact_type: "WORK_MODE" }),
      factBody({ source_type: "GUESS" }),
      factBody({ source_url: "javascript:alert(1)" }),
      factBody({ job_version_id: undefined }),
    ]) {
      const response = await call("POST", path, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body.error).toBe("INVALID_REQUEST");
    }
    expect((await call("POST", "/jobs/not-a-uuid/confirmed-facts", factBody())).status).toBe(400);
    const missing = await call("POST", `/jobs/${randomUUID()}/confirmed-facts`, factBody());
    expect(missing.status).toBe(404);
    const stale = await call("POST", path, factBody({ job_version_id: staleVersionId }));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("JOB_VERSION_NOT_CURRENT");
    const { rows } = await getPool().query(`SELECT COUNT(*)::int AS count FROM job_confirmed_facts`);
    expect(rows[0].count).toBe(0);
  });

  it("records a fact, enqueues the gate re-run and returns the read model with history", async () => {
    const path = `/jobs/${canonicalJobId}/confirmed-facts`;
    const created = await call("POST", path, factBody());
    expect(created.status).toBe(201);
    const parsed = JobConfirmedFactResponseSchema.parse(created.body);
    expect(parsed.fact).toMatchObject({
      fact_type: "OFFICE_DAYS",
      fact_value: { office_days_min: 2, office_days_max: 2 },
      source_type: "RECRUITER_EMAIL",
      source_note: "Recruiter confirmed by email",
      source_url: "https://careers.example.test/confirmed-api/role",
      supersedes_fact_id: null,
      recorded_by_user_id: getContext().userId,
    });
    expect(parsed.rerun).toMatchObject({
      task_type: "APPLY_HARD_GATES",
      task_key: `APPLY_HARD_GATES:${jobVersionId}:hard_gate_v1:confirmed-fact:${parsed.fact.confirmed_fact_id}`,
      inserted: true,
    });
    const task = await getPool().query<{ status: string }>(
      `SELECT status FROM pipeline_tasks WHERE id = $1`,
      [parsed.rerun.task_id],
    );
    expect(task.rows[0]?.status).toBe("PENDING");

    const corrected = await call("POST", path, factBody({
      value: { office_days_min: 1, office_days_max: 2 },
      source_type: "HIRING_MANAGER",
      source_note: null,
      source_url: null,
    }));
    expect(corrected.status).toBe(201);
    expect(corrected.body.superseded_fact_id).toBe(parsed.fact.confirmed_fact_id);

    const listed = JobConfirmedFactsListResponseSchema.parse((await call("GET", path)).body);
    expect(listed.checks?.open_checks).toEqual([]);
    expect(listed.checks?.rerun_pending).toBe(true);
    expect(listed.checks?.confirmed_facts).toHaveLength(1);
    expect(listed.checks?.confirmed_facts[0]).toMatchObject({
      fact_value: { office_days_min: 1, office_days_max: 2 },
      source_type: "HIRING_MANAGER",
      supersedes_fact_id: parsed.fact.confirmed_fact_id,
    });
    expect(listed.history.map((fact) => fact.confirmed_fact_id)).toEqual([
      corrected.body.fact.confirmed_fact_id,
      parsed.fact.confirmed_fact_id,
    ]);
  });
});
