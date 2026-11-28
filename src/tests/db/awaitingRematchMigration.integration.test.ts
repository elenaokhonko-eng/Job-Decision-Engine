import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { syncRematchWaits } from "../../modules/decision/index.js";

// Migration 124 on real PostgreSQL, in its own schema; invented rows only.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
const FILE = "124_awaiting_rematch_view.sql";

/** The reversal statements exactly as the migration's header documents them. */
function documentedReversal(): string[] {
  const header = fs.readFileSync(path.join(process.cwd(), "migrations", FILE), "utf8").split(/\r?\n/);
  return header.filter((line) => /^--   (DROP|DELETE) /.test(line)).map((line) => line.slice(5));
}

describe.skipIf(skipReal)("migration 124: waits for a re-match (PostgreSQL)", { timeout: 180_000 }, () => {
  const schema = `m124_${randomUUID().replaceAll("-", "")}`;
  let pool: pg.Pool;
  let client: pg.PoolClient;

  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await runMigrations(client);
  }, 180_000);

  afterAll(async () => {
    await client.query("RESET search_path").catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    client.release();
    await pool.end();
  });

  const exists = async (name: string) =>
    (await client.query<{ found: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS found`, [`${schema}.${name}`])).rows[0]!.found;

  it("rejects a wait whose workspace is not the job's, and accepts the matching pair", async () => {
    const own = (await client.query<{ id: string; workspace_id: string }>(
      `INSERT INTO canonical_jobs (company_name, normalized_title, canonical_url, processing_state, processing_status)
       VALUES ('Synthetic Wait Fixture', 'synthetic role', 'https://example.test/wait', 'RAW_STAGED', 'RAW_STAGED')
       RETURNING id, workspace_id`,
    )).rows[0]!;
    const other = (await client.query<{ id: string }>(
      `INSERT INTO workspaces (workspace_key, display_name) VALUES ($1, 'Synthetic Other Workspace') RETURNING id`,
      [`other_${randomUUID().slice(0, 8)}`],
    )).rows[0]!.id;
    const insert = (workspaceId: string) => client.query(
      `INSERT INTO job_rematch_waits (workspace_id, canonical_job_id) VALUES ($1, $2)`, [workspaceId, own.id]);

    await expect(insert(other)).rejects.toMatchObject({ code: "23503" });
    await insert(own.workspace_id);
    expect((await client.query(`SELECT 1 FROM job_rematch_waits`)).rows).toHaveLength(1);
  });

  it("records waits in job id order, so two syncs take their locks the same way", async () => {
    const ids = ["f", "d", "b", "e", "c", "a"].map((digit) => `${digit}0000000-0000-4000-8000-000000000000`);
    for (const id of ids) {
      await client.query(
        `INSERT INTO canonical_jobs (id, company_name, normalized_title, canonical_url, processing_state, processing_status,
                                     recommendation_requirement_score)
         VALUES ($1::uuid, 'Synthetic Order Fixture', 'synthetic role', 'https://example.test/order/' || $1::text, 'MATCHED', 'MATCHED', 0.5)`,
        [id],
      );
    }
    const workspace = (await client.query<{ workspace_id: string }>(`SELECT workspace_id FROM canonical_jobs WHERE id = $1`, [ids[0]])).rows[0]!;
    // Without index scans the rows would arrive in the order they were stored, which is not id order.
    const planner = ["enable_indexscan", "enable_indexonlyscan", "enable_bitmapscan", "enable_mergejoin"];
    for (const setting of planner) await client.query(`SET ${setting} = off`);
    await syncRematchWaits(client, workspace.workspace_id);
    for (const setting of planner) await client.query(`RESET ${setting}`);
    // The physical order of a fresh set of rows is the order they were inserted, which is the order they were locked.
    const inserted = await client.query<{ canonical_job_id: string }>(
      `SELECT canonical_job_id::text FROM job_rematch_waits WHERE canonical_job_id = ANY($1::uuid[]) ORDER BY ctid`, [ids]);
    expect(inserted.rows.map((row) => row.canonical_job_id)).toEqual([...ids].sort());
  });

  it("is undone by the documented statements, after which the runner applies it again", async () => {
    const statements = documentedReversal();
    expect(statements).toHaveLength(3);
    for (const statement of statements) await client.query(statement);
    expect(await exists("job_rematch_waits")).toBe(false);
    expect(await exists("v_job_awaiting_rematch")).toBe(false);

    await runMigrations(client);
    expect(await exists("job_rematch_waits")).toBe(true);
    expect(await exists("v_job_awaiting_rematch")).toBe(true);
    expect((await client.query(`SELECT 1 FROM schema_migrations WHERE version = $1`, [FILE])).rows).toHaveLength(1);
  });
});
