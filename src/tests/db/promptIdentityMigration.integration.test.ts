import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// Migration 118 adds nullable prompt_id and prompt_version to three tables. This test runs against a
// real PostgreSQL schema: columns, nullability, the set-together rule, idempotence and the documented
// rollback. Fixtures are synthetic.
const MIGRATION_FILE = "118_prompt_identity_columns.sql";
const TABLES = ["ai_evaluations", "document_runs", "manual_application_document_runs"] as const;
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the prompt identity migration test against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let context: WorkspaceContext | undefined;
let migrationSql = "";

function db(): pg.PoolClient {
  if (!client) throw new Error("The prompt identity migration test client is not initialized.");
  return client;
}

async function promptColumns(table: string): Promise<Array<{ column_name: string; is_nullable: string; column_default: string | null }>> {
  const { rows } = await db().query(
    `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
        AND column_name IN ('prompt_id', 'prompt_version')
      ORDER BY column_name`,
    [table],
  );
  return rows;
}

async function hasPairConstraint(table: string): Promise<boolean> {
  const { rowCount } = await db().query(
    `SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass($1) AND conname = $2`,
    [table, `${table}_prompt_pair_chk`],
  );
  return (rowCount ?? 0) > 0;
}

async function insertEvaluation(promptId: string | null, promptVersion: string | null): Promise<void> {
  await db().query(
    `INSERT INTO ai_evaluations (workspace_id, prompt_id, prompt_version) VALUES ($1, $2, $3)`,
    [context!.workspaceId, promptId, promptVersion],
  );
}

async function rejects(sql: string, params: unknown[]): Promise<boolean> {
  await db().query("SAVEPOINT attempt");
  try {
    await db().query(sql, params);
    await db().query("RELEASE SAVEPOINT attempt");
    return false;
  } catch (error) {
    await db().query("ROLLBACK TO SAVEPOINT attempt");
    return (error as { code?: string }).code === "23514";
  }
}

/** The rollback statements are documented in the migration header; the test runs exactly those. */
function documentedRollback(sql: string): string[] {
  const lines = sql.split("\n");
  const start = lines.findIndex((line) => line.startsWith("-- Rollback"));
  expect(start).toBeGreaterThanOrEqual(0);
  return lines
    .slice(start + 1)
    .filter((line) => /^--\s+ALTER TABLE/.test(line))
    .map((line) => line.replace(/^--\s+/, ""));
}

describe.skipIf(skipReal)("migration 118: prompt id and version columns (PostgreSQL)", () => {
  beforeAll(async () => {
    migrationSql = await fs.readFile(path.resolve("migrations", MIGRATION_FILE), "utf8");
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    const schemaName = `prompt_identity_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    await client.query("BEGIN");
  });

  afterAll(async () => {
    await client?.query("ROLLBACK").catch(() => undefined);
    client?.release();
    await pool?.end();
  });

  it("is applied by the normal migration run", async () => {
    const { rowCount } = await db().query(`SELECT 1 FROM schema_migrations WHERE version = $1`, [MIGRATION_FILE]);
    expect(rowCount).toBe(1);
  });

  it.each(TABLES)("adds two nullable columns with no default to %s, plus the pair rule", async (table) => {
    expect(await promptColumns(table)).toEqual([
      { column_name: "prompt_id", is_nullable: "YES", column_default: null },
      { column_name: "prompt_version", is_nullable: "YES", column_default: null },
    ]);
    expect(await hasPairConstraint(table)).toBe(true);
  });

  it("leaves a row written without a prompt as NULL and NULL", async () => {
    await insertEvaluation(null, null);
    const { rows } = await db().query(
      `SELECT prompt_id, prompt_version FROM ai_evaluations ORDER BY evaluated_at DESC LIMIT 1`,
    );
    expect(rows[0]).toEqual({ prompt_id: null, prompt_version: null });
  });

  it("accepts a prompt id with its version", async () => {
    await insertEvaluation("job_evaluation", "2026-11-01.1");
    const { rows } = await db().query(
      `SELECT prompt_id, prompt_version FROM ai_evaluations WHERE prompt_id = 'job_evaluation'`,
    );
    expect(rows).toEqual([{ prompt_id: "job_evaluation", prompt_version: "2026-11-01.1" }]);
  });

  it("rejects an id without a version, a version without an id, and blank or oversized values", async () => {
    const sql = `INSERT INTO ai_evaluations (workspace_id, prompt_id, prompt_version) VALUES ($1, $2, $3)`;
    const workspaceId = context!.workspaceId;
    expect(await rejects(sql, [workspaceId, "job_evaluation", null])).toBe(true);
    expect(await rejects(sql, [workspaceId, null, "1"])).toBe(true);
    expect(await rejects(sql, [workspaceId, "  ", "1"])).toBe(true);
    expect(await rejects(sql, [workspaceId, "job_evaluation", ""])).toBe(true);
    expect(await rejects(sql, [workspaceId, "x".repeat(201), "1"])).toBe(true);
  });

  it("applies the same rule to document_runs", async () => {
    const workspaceId = context!.workspaceId;
    const canonical = await db().query<{ id: string }>(
      `INSERT INTO canonical_jobs (workspace_id, company_name, normalized_title, canonical_url)
       VALUES ($1, 'Prompt Fixture Co', 'Fixture Role', $2) RETURNING id`,
      [workspaceId, `https://example.test/prompt/${crypto.randomUUID()}`],
    );
    const version = await db().query<{ id: string }>(
      `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at)
       VALUES ($1, $2, 1, $3, 'Synthetic prompt fixture.', NOW()) RETURNING id`,
      [workspaceId, canonical.rows[0]!.id, `prompt-${crypto.randomUUID()}`],
    );
    const sql = `INSERT INTO document_runs (canonical_job_id, job_version_id, document_type, status, policy_version,
                   generator_version, output_manifest, prompt_id, prompt_version)
                 VALUES ($1, $2, 'CV', 'STARTED', 'p1', 'g1', '{}'::jsonb, $3, $4)`;
    const ids = [canonical.rows[0]!.id, version.rows[0]!.id];
    expect(await rejects(sql, [...ids, "cv_draft", null])).toBe(true);
    await db().query(sql, [...ids, "cv_draft", "3"]);
    await db().query(sql, [...ids, null, null]);
  });

  it("can be applied again without error or change", async () => {
    await db().query(migrationSql);
    for (const table of TABLES) {
      expect(await promptColumns(table)).toHaveLength(2);
      expect(await hasPairConstraint(table)).toBe(true);
    }
  });

  it("is undone by the rollback in its header, and applies again afterwards", async () => {
    const statements = documentedRollback(migrationSql);
    expect(statements).toHaveLength(6);
    for (const statement of statements) await db().query(statement);
    for (const table of TABLES) {
      expect(await promptColumns(table)).toEqual([]);
      expect(await hasPairConstraint(table)).toBe(false);
    }
    await db().query(migrationSql);
    for (const table of TABLES) expect(await promptColumns(table)).toHaveLength(2);
  });
});
