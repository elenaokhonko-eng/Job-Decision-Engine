import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { findTasksCompletedWithoutResult } from "../../tasks/completedWithoutResult.js";
import { completedTasksWithoutResult, runZeroChecks, zeroChecksExitCode } from "../../tasks/integrityZeroChecks.js";

// scripts/reconcile_pipeline.ts used to print a separate completed_without_result report and exit 1 on it. That report
// is now the task_completed_without_result zero check. This test shows the zero check reports every case the old report
// did, keeps every by-design exclusion, and that the reconcile exit code is 1 on each violation. Synthetic data only.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the zero-check parity tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
const db = (): pg.PoolClient => { if (!client) throw new Error("not initialised"); return client; };

async function workspace(): Promise<string> {
  const row = await db().query<{ id: string }>(`INSERT INTO workspaces (workspace_key, display_name) VALUES ($1, 'Parity') RETURNING id::text`, [`parity-${randomUUID()}`]);
  return row.rows[0]!.id;
}

async function job(ws: string, state = "MATCHED"): Promise<{ canonicalJobId: string; jobVersionId: string }> {
  const canonicalJobId = randomUUID();
  const jobVersionId = randomUUID();
  await db().query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status)
     VALUES ($1, $2, 'Parity Co', 'fixture role', $3, $4, $4)`, [canonicalJobId, ws, `https://example.test/p/${canonicalJobId}`, state]);
  await db().query(`INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at) VALUES ($1, $2, $3, $4, 'Synthetic.', NOW())`,
    [jobVersionId, ws, canonicalJobId, `h-${jobVersionId}`]);
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [jobVersionId, canonicalJobId]);
  return { canonicalJobId, jobVersionId };
}

async function observation(ws: string, jobVersionId: string): Promise<void> {
  await db().query(
    `INSERT INTO raw_job_observations (workspace_id, source_name, source_external_id, source_url, retrieved_at, company_name, title, description_raw,
       raw_payload, raw_payload_hash, processing_status, job_version_id)
     VALUES ($1, 'GREENHOUSE', $2, $3, NOW(), 'Parity Co', 'fixture role', 'x', '{}'::jsonb, $4, 'PROCESSED', $5)`,
    [ws, `o-${randomUUID()}`, `https://example.test/o/${randomUUID()}`, randomUUID().replaceAll("-", "").padEnd(64, "0"), jobVersionId]);
}

async function completed(ws: string, taskType: string, jobVersionId: string, repairAction: string | null = null): Promise<string> {
  const id = randomUUID();
  await db().query(
    `INSERT INTO pipeline_tasks (id, workspace_id, task_type, task_key, payload, status, completed_at, repair_action)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'COMPLETED', NOW(), $6)`,
    [id, ws, taskType, `${taskType}:${jobVersionId}:${id}`, JSON.stringify({ job_version_id: jobVersionId }), repairAction]);
  return id;
}

async function exitCodeFor(ws: string): Promise<0 | 1> {
  return zeroChecksExitCode(await runZeroChecks(db(), ws, { phase: "pre" }));
}

describe.skipIf(skipReal)("task_completed_without_result replaces the dropped completed_without_result report (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `zero_parity_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  const taskTypes = ["APPLY_HARD_GATES", "ROUTE_LANE", "MATCH_PROFILE_EVIDENCE", "DECIDE_RECOMMENDATION", "RECHECK_AVAILABILITY"] as const;

  it.each(taskTypes)("%s completed without a result is reported by the zero check, matches the old report, and the reconcile exit code is 1", async (taskType) => {
    const ws = await workspace();
    const j = await job(ws);
    if (taskType === "RECHECK_AVAILABILITY") await observation(ws, j.jobVersionId);
    const taskId = await completed(ws, taskType, j.jobVersionId);
    const check = await completedTasksWithoutResult(db(), ws);
    const old = await findTasksCompletedWithoutResult(db(), ws);
    expect(check.sample).toEqual([taskId]);
    expect(check.total).toBe(old.total);
    expect(check.detail).toEqual(old.byTaskType);
    expect(check.detail).toEqual({ [taskType]: 1 });
    expect(await exitCodeFor(ws)).toBe(1);
  });

  it("every by-design exclusion of the old report still holds, and the exit code is 0", async () => {
    const ws = await workspace();
    const closedWithoutRunning = await job(ws);
    await completed(ws, "DECIDE_RECOMMENDATION", closedWithoutRunning.jobVersionId, "RECONCILED_PROVEN_SATISFIED");
    const archived = await job(ws);
    await completed(ws, "MATCH_PROFILE_EVIDENCE", archived.jobVersionId);
    const run = await db().query<{ id: string }>(
      `INSERT INTO job_archive_runs (run_started_at, cutoff_at, mode, status) VALUES (NOW(), NOW() - INTERVAL '1 second', 'APPLY', 'RUNNING') RETURNING id::text`);
    await db().query(
      `UPDATE canonical_jobs SET archived_at = NOW(), archive_reason = 'POSTING_NOT_CONFIRMABLE', archive_age_basis = 'POSTING_LINK_UNVERIFIABLE',
              archive_reference_at = NOW(), archive_run_id = $2 WHERE id = $1`, [archived.canonicalJobId, run.rows[0]!.id]);
    const stale = await job(ws);
    await completed(ws, "DECIDE_RECOMMENDATION", stale.jobVersionId);
    const newer = randomUUID();
    await db().query(`INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at) VALUES ($1, $2, $3, $4, 'Newer.', NOW())`, [newer, ws, stale.canonicalJobId, `h-${newer}`]);
    await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [newer, stale.canonicalJobId]);
    const fixture = await job(ws);
    await completed(ws, "MATCH_PROFILE_EVIDENCE", fixture.jobVersionId);
    await db().query(`UPDATE canonical_jobs SET is_test_fixture = TRUE WHERE id = $1`, [fixture.canonicalJobId]);
    const removed = await job(ws, "MANUALLY_REMOVED");
    await completed(ws, "DECIDE_RECOMMENDATION", removed.jobVersionId);
    const deferred = await job(ws, "ROUTING_DEFERRED");
    await completed(ws, "ROUTE_LANE", deferred.jobVersionId);
    const noObservation = await job(ws);
    await completed(ws, "RECHECK_AVAILABILITY", noObservation.jobVersionId);
    expect((await completedTasksWithoutResult(db(), ws)).total).toBe(0);
    expect((await findTasksCompletedWithoutResult(db(), ws)).total).toBe(0);
    expect(await exitCodeFor(ws)).toBe(0);
  });

  it("a mixed workspace gives the same total, the same per-type counts and the same ids as the old report", async () => {
    const ws = await workspace();
    for (const taskType of taskTypes) {
      const j = await job(ws);
      if (taskType === "RECHECK_AVAILABILITY") await observation(ws, j.jobVersionId);
      await completed(ws, taskType, j.jobVersionId);
    }
    const check = await completedTasksWithoutResult(db(), ws);
    const old = await findTasksCompletedWithoutResult(db(), ws, { sampleLimit: 200 });
    expect(check.total).toBe(5);
    expect(check.detail).toEqual(old.byTaskType);
    expect([...check.sample].sort()).toEqual(old.sample.map((row) => row.taskId).sort());
  });

  it("the reconcile script exits 1 from the zero checks and nothing reads the dropped JSON key any more", () => {
    const script = fs.readFileSync("scripts/reconcile_pipeline.ts", "utf8");
    expect(script).toMatch(/zeroChecksExitCode\(report\.zero_checks\) !== 0\) process\.exitCode = 1/);
    expect(script).not.toContain("completed_without_result");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".git", "dist"].includes(entry.name)) continue;
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|mjs|json|ya?ml|md|py|sh|ps1)$/.test(entry.name) && fs.readFileSync(full, "utf8").includes("completed_without_result")) hits.push(full);
      }
    };
    for (const dir of [".github", "scripts", "src", "desktop", "docs", ".agents", ".streamlit"]) if (fs.existsSync(dir)) walk(dir);
    // Only the check's own implementation and its tests may name the old key (the zero-check name is task_completed_without_result).
    expect(hits.filter((file) => !/completedWithoutResult|zeroCheck|integrityZeroChecks|DATA-FLOW-CONTRACT/.test(file))).toEqual([]);
  });
});
