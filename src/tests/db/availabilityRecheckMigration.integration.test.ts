import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// Migration 119: the state and audit tables for RECHECK_AVAILABILITY. Synthetic data only.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the availability re-check migration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let context: WorkspaceContext | undefined;

function db(): pg.PoolClient {
  if (!client) throw new Error("The migration test client is not initialized.");
  return client;
}

async function insertJob(): Promise<string> {
  const row = await db().query<{ id: string }>(
    `INSERT INTO canonical_jobs (workspace_id, company_name, normalized_title, canonical_url)
     VALUES ($1, 'Migration Fixture Co', 'Fixture Role', $2) RETURNING id`,
    [context!.workspaceId, `https://example.test/m119/${crypto.randomUUID()}`],
  );
  return row.rows[0]!.id;
}

describe.skipIf(skipReal)("migration 119: availability re-check state (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    const schemaName = `m119_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
  });

  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  it("stores one counter row per job and rejects negative counters", async () => {
    const jobId = await insertJob();
    await db().query(
      `INSERT INTO job_availability_recheck_state (workspace_id, canonical_job_id, consecutive_absent_reads) VALUES ($1, $2, 1)`,
      [context!.workspaceId, jobId],
    );
    await expect(db().query(
      `INSERT INTO job_availability_recheck_state (workspace_id, canonical_job_id) VALUES ($1, $2)`,
      [context!.workspaceId, jobId],
    )).rejects.toThrow();
    await expect(db().query(
      `UPDATE job_availability_recheck_state SET consecutive_absent_reads = -1 WHERE canonical_job_id = $1`,
      [jobId],
    )).rejects.toThrow();
  });

  it("accepts only the known outcomes and decisions in the event log", async () => {
    const jobId = await insertJob();
    const insert = (outcome: string, decision: string) => db().query(
      `INSERT INTO job_availability_recheck_events (
         workspace_id, canonical_job_id, read_kind, outcome, decision, reason_code,
         consecutive_absent_reads_after, cannot_tell_attempts_after
       ) VALUES ($1, $2, 'FEED', $3, $4, 'TEST', 1, 0)`,
      [context!.workspaceId, jobId, outcome, decision],
    );
    await insert("FEED_ABSENT", "WAIT_NEXT_READ");
    await expect(insert("GUESSED_CLOSED", "WAIT_NEXT_READ")).rejects.toThrow();
    await expect(insert("FEED_ABSENT", "DELETE_JOB")).rejects.toThrow();
  });

  it("the event log cannot be updated, deleted or truncated", async () => {
    const jobId = await insertJob();
    await db().query(
      `INSERT INTO job_availability_recheck_events (workspace_id, canonical_job_id, read_kind, outcome, decision, reason_code,
         consecutive_absent_reads_after, cannot_tell_attempts_after)
       VALUES ($1, $2, 'FEED', 'FEED_ABSENT', 'WAIT_NEXT_READ', 'TEST', 1, 0)`,
      [context!.workspaceId, jobId],
    );
    await expect(db().query(`UPDATE job_availability_recheck_events SET reason_code = 'X' WHERE canonical_job_id = $1`, [jobId])).rejects.toThrow(/append-only/);
    await expect(db().query(`DELETE FROM job_availability_recheck_events WHERE canonical_job_id = $1`, [jobId])).rejects.toThrow(/append-only/);
    await expect(db().query(`TRUNCATE job_availability_recheck_events`)).rejects.toThrow(/append-only/);
  });

  it("is additive: the rollback statements remove only the two new tables", async () => {
    await db().query("BEGIN");
    try {
      await db().query("DROP TABLE IF EXISTS job_availability_recheck_events");
      await db().query("DROP TABLE IF EXISTS job_availability_recheck_state");
      await db().query("DROP FUNCTION IF EXISTS job_availability_recheck_events_append_only()");
      const left = await db().query<{ present: boolean }>(
        `SELECT to_regclass('canonical_jobs') IS NOT NULL AS present`,
      );
      expect(left.rows[0]?.present).toBe(true);
    } finally {
      await db().query("ROLLBACK");
    }
  });
});
