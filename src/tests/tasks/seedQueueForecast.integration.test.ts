import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { forecastFirstRunQueue } from "../../tasks/seedQueueForecast.js";

// Read-only forecast of the first run's queue. Synthetic data only.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the seed forecast test against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
const db = (): pg.PoolClient => { if (!client) throw new Error("not initialised"); return client; };

describe.skipIf(skipReal)("first-run queue forecast (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `forecast_${randomUUID().replaceAll("-", "")}`;
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

  it("is all zero for an empty workspace, and counts a job gated under an older gate version, without writing", async () => {
    const ws = (await db().query<{ id: string }>(
      `INSERT INTO workspaces (workspace_key, display_name) VALUES ($1, 'Forecast workspace') RETURNING id::text`, [`f-${randomUUID()}`])).rows[0]!.id;
    expect(await forecastFirstRunQueue(db(), ws)).toEqual({
      liveJobs: 0, extractorWouldQueue: 0, gateWouldQueue: 0, matcherWouldQueue: 0, laneRouterPool: 0,
      embedding: { activeSpaces: 0, inputsMissingInActiveSpace: 0, charsMissingInActiveSpace: 0 },
    });
    const canonicalJobId = randomUUID();
    const jobVersionId = randomUUID();
    await db().query(
      `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status)
       VALUES ($1, $2, 'Forecast Co', 'fixture role', $3, 'PREQUALIFIED', 'PREQUALIFIED')`, [canonicalJobId, ws, `https://example.test/f/${canonicalJobId}`]);
    await db().query(`INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at) VALUES ($1, $2, $3, $4, 'x', NOW())`,
      [jobVersionId, ws, canonicalJobId, `h-${jobVersionId}`]);
    await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [jobVersionId, canonicalJobId]);
    await db().query(`INSERT INTO gate_decisions (canonical_job_id, job_version_id, decision, gate_version, workspace_id) VALUES ($1, $2, 'PASS', 'gate-old', $3)`,
      [canonicalJobId, jobVersionId, ws]);
    const before = await db().query<{ n: string }>(`SELECT COUNT(*) AS n FROM pipeline_tasks`);
    await db().query("BEGIN READ ONLY");
    const forecast = await forecastFirstRunQueue(db(), ws);
    await db().query("ROLLBACK");
    expect(forecast).toMatchObject({ liveJobs: 1, gateWouldQueue: 1, extractorWouldQueue: 1, laneRouterPool: 1 });
    const after = await db().query<{ n: string }>(`SELECT COUNT(*) AS n FROM pipeline_tasks`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});
