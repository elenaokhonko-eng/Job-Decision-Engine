import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "crypto";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { runNormalization } from "../../pipeline/normalize.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// Real PostgreSQL: every migration runs, then a synthetic multi-office posting is normalized.
// Before migration 106 its location (over 255 characters) failed the canonical_jobs insert.
const databaseUrl = process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

const OFFICES = [
  "SGP-Singapore-1 Example Quay", "PHL-Taguig City-Example Plaza", "THA-Bangkok-Example Tower",
  "MYS-Penang-Example Precinct", "MYS-Kuala Lumpur-Example Sentral", "IDN-Jakarta-Example Center",
  "VNM-Ho Chi Minh City-Example Building", "IND-Bengaluru-Example Tech Park", "HKG-Hong Kong-Example Place",
];
const LONG_LOCATION = OFFICES.join("; ");

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function db(): pg.PoolClient {
  if (!client) throw new Error("The integration test database client is not initialized.");
  return client;
}

describe.skipIf(skipReal)("canonical job location width", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `canonical_location_width_${Date.now()}_${crypto.randomInt(100000, 999999)}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
  }, 180_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
      client = undefined;
    }
    if (pool) {
      await pool.end();
      pool = undefined;
    }
  });

  it("stores the column as text and keeps every dependent read-model view with its comment", async () => {
    const column = await db().query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'canonical_jobs' AND column_name = 'location'`,
      [schemaName],
    );
    expect(column.rows).toEqual([{ data_type: "text" }]);

    const views = await db().query<{ relname: string; comment: string | null }>(
      `SELECT c.relname, obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c
       WHERE c.relnamespace = to_regnamespace($1)
         AND c.relname IN ('v_canonical_shortlist', 'v_canonical_shortlist_scoped', 'v_archived_jobs_scoped')
       ORDER BY c.relname`,
      [schemaName],
    );
    expect(views.rows.map((row) => row.relname)).toEqual(["v_archived_jobs_scoped", "v_canonical_shortlist", "v_canonical_shortlist_scoped"]);
    expect(views.rows.find((row) => row.relname === "v_canonical_shortlist_scoped")?.comment).toContain("Active canonical shortlist only");
    expect(views.rows.find((row) => row.relname === "v_archived_jobs_scoped")?.comment).toContain("Workspace-scoped archived vacancy list");
  });

  it("normalizes a posting whose location lists more than 255 characters of offices, unchanged", async () => {
    expect(LONG_LOCATION.length).toBeGreaterThan(255);
    const ctx = context!;
    const run = await db().query<{ id: string }>(
      `INSERT INTO source_runs (workspace_id, status, total_fetched, total_new) VALUES ($1, 'COMPLETED', 1, 1) RETURNING id`,
      [ctx.workspaceId],
    );
    const url = "https://careers.example.test/jobs/multi-office-consultant";
    const description = [
      "Synthetic Example Analytics is hiring a business consultant for its risk intelligence products.",
      "Responsibilities: advise customers on data products, run workshops and support adoption across the region.",
      "Requirements: experience with financial data, risk analytics and customer consulting.",
    ].join("\n");
    const payload = JSON.stringify({ source: "LOCATION_WIDTH_FIXTURE", url });
    const observation = await db().query<{ id: string }>(
      `INSERT INTO raw_job_observations (
         workspace_id, source_run_id, source_name, source_external_id, source_url, retrieved_at,
         company_name, title, description_raw, location_raw, workplace_type_raw, employment_type_raw,
         compensation_raw, canonical_apply_url, source_lane, search_plan_version, raw_payload, raw_payload_hash
       ) VALUES ($1, $2, 'WORKDAY', 'workday:example:multi-office', $3, NOW(), 'Synthetic Example Analytics',
         'Business Consultant - Risk Intelligence', $4, $5, 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', $3, 'UNKNOWN',
         'location_width_fixture_v1', $6::jsonb, $7) RETURNING id`,
      [ctx.workspaceId, run.rows[0].id, url, description, LONG_LOCATION, payload,
        crypto.createHash("sha256").update(payload).digest("hex")],
    );

    const summary = await runNormalization(db(), { context: ctx, observationIds: [observation.rows[0].id], limit: 1 });
    expect(summary.totalErrors).toBe(0);
    expect(summary.totalProcessed).toBe(1);
    const canonicalJobId = summary.details[0]?.canonicalJobId;
    const stored = await db().query<{ location: string }>(`SELECT location FROM canonical_jobs WHERE id = $1`, [canonicalJobId]);
    expect(stored.rows[0]?.location).toBe(LONG_LOCATION);
    const shortlist = await db().query(`SELECT 1 FROM v_canonical_shortlist LIMIT 1`);
    expect(shortlist.rowCount).toBeGreaterThanOrEqual(0);
  });
});
