import { describe, it, expect } from "vitest";
import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runMigrations } from "../../db/migrate.js";

const DB_URL = process.env.DATABASE_URL || "";
const isCI = DB_URL.includes("localhost") || DB_URL.includes("127.0.0.1");
const skipReal = !DB_URL || !isCI;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, "../../../migrations");

function migrationNumber(file: string): number | null {
  const match = file.match(/^(\d{3})/);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

async function applyMigrationFile(client: pg.PoolClient, file: string): Promise<void> {
  const sqlContent = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8").replace(/^\uFEFF/, "");
  await client.query("BEGIN");
  try {
    await client.query(sqlContent);
    await client.query(
      `INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW()) ON CONFLICT (version) DO NOTHING`,
      [file]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

describe.skipIf(skipReal)("P11: upgrade from migration 018 (integration)", () => {
  it("applies baseline 001-018 then upgrades to the latest schema (incl. 035)", async () => {
    const pool = new pg.Pool({ connectionString: DB_URL });
    const client = await pool.connect();
    const schemaName = `upgrade_018_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version VARCHAR(255) PRIMARY KEY,
          applied_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      const allFiles = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql") && !f.startsWith("."))
        .sort();

      const baselineFiles = allFiles.filter((f) => {
        const n = migrationNumber(f);
        return typeof n === "number" && n <= 18;
      });

      for (const file of baselineFiles) {
        await applyMigrationFile(client, file);
      }

      const applied = await runMigrations(client);
      expect(applied.length).toBeGreaterThan(0);

      const tables = await client.query<{ table_name: string }>(
        `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1
        `,
        [schemaName]
      );
      const tableNames = new Set(tables.rows.map((r) => r.table_name));

      expect(tableNames.has("workspaces")).toBe(true);
      expect(tableNames.has("pipeline_tasks")).toBe(true);
      expect(tableNames.has("backfill_runs")).toBe(true);
      expect(tableNames.has("parity_audit_runs")).toBe(true);

      const { rows: migRows } = await client.query<{ version: string }>(
        `SELECT version FROM schema_migrations WHERE version = '035_v22_read_models_and_cutover.sql' LIMIT 1`
      );
      expect(migRows).toHaveLength(1);
    } finally {
      await client.query(`RESET search_path`).catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
      await pool.end();
    }
  });
});

