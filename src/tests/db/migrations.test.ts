/**
 * P0-03 — Additive Migration Chain & Canonical Schema Integrity
 *
 * Two tiers:
 *  TIER 1 — Mock-based (always run): verify idempotency logic and
 *    transaction wrapping without a live DB.
 *  TIER 2 — Real PostgreSQL (CI only): apply all migrations against
 *    the actual postgres:15 CI container and assert table/column
 *    existence, including the 004 backoff+gmail_uid additions.
 */
import { describe, it, expect, vi, afterAll, beforeAll } from "vitest";
import pg from "pg";
import { runMigrations } from "../../db/migrate.js";

// ── CI detection ──────────────────────────────────────────────────────────────

const DB_URL = process.env.DATABASE_URL || "";
const isCI = DB_URL.includes("localhost") || DB_URL.includes("127.0.0.1");
const skipReal = !DB_URL || !isCI;

// ── Tier 1: Mock tests (always run) ──────────────────────────────────────────

describe("P0-03: Additive Migration Chain & Canonical Schema Integrity", () => {
  it("should track and apply migrations idempotently", async () => {
    const executedQueries: string[] = [];
    const appliedVersions: string[] = [];

    const mockClient: any = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        executedQueries.push(sql);
        if (sql.includes("SELECT version FROM schema_migrations")) {
          return { rows: appliedVersions.map((v) => ({ version: v })) };
        }
        if (sql.includes("INSERT INTO schema_migrations")) {
          appliedVersions.push(params?.[0]);
          return { rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    // First run: should apply all unapplied migrations
    const firstRun = await runMigrations(mockClient);
    expect(firstRun.length).toBeGreaterThanOrEqual(3);
    expect(firstRun).toContain("001_legacy_tables.sql");
    expect(firstRun).toContain("002_stage0_discovery.sql");
    expect(firstRun).toContain("003_canonical_schema_hardening.sql");

    // Second run: should apply 0 migrations (idempotent)
    const secondRun = await runMigrations(mockClient);
    expect(secondRun).toHaveLength(0);
  });

  it("should execute migrations inside BEGIN / COMMIT transactions", async () => {
    const txLog: string[] = [];
    const mockClient: any = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          txLog.push(sql);
        }
        if (sql.includes("SELECT version FROM schema_migrations")) {
          return { rows: [] };
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    await runMigrations(mockClient);

    expect(txLog).toContain("BEGIN");
    expect(txLog).toContain("COMMIT");
    expect(txLog).not.toContain("ROLLBACK");
  });
});

// ── Tier 2: Real PostgreSQL migration tests (CI only) ─────────────────────────

let realPool: pg.Pool;

describe.skipIf(skipReal)("P0-03: Real PostgreSQL Migration Verification", () => {
  beforeAll(async () => {
    realPool = new pg.Pool({ connectionString: DB_URL });
    // Apply all migrations to ensure schema is current
    await runMigrations(realPool);
  });

  afterAll(async () => {
    await realPool.end();
  });

  it("all migration files are recorded in schema_migrations", async () => {
    const { rows } = await realPool.query(
      `SELECT version FROM schema_migrations ORDER BY version ASC`
    );
    const versions = rows.map((r: any) => r.version);
    expect(versions).toContain("001_legacy_tables.sql");
    expect(versions).toContain("002_stage0_discovery.sql");
    expect(versions).toContain("003_canonical_schema_hardening.sql");
    expect(versions).toContain("004_queue_backoff_and_gmail_uid.sql");
    expect(versions).toContain("005_streamlit_read_model.sql");
    expect(versions).toContain("006_schema_hardening_v2.sql");
    expect(versions).toContain("007_job_version_integrity.sql");
    expect(versions).toContain("008_job_version_integrity_v2.sql");
  });

  it("canonical_jobs table has all required columns from migrations 001–004", async () => {
    const { rows } = await realPool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'canonical_jobs'
    `);
    const cols = rows.map((r: any) => r.column_name);

    // Core identity columns (001/002)
    expect(cols).toContain("id");
    expect(cols).toContain("company_name");
    expect(cols).toContain("processing_status");
    expect(cols).toContain("primary_lane");

    // Hardening columns (003)
    expect(cols).toContain("secondary_lanes");
    expect(cols).toContain("rejection_reason");

    // Backoff columns (004)
    expect(cols).toContain("gate_evidence_quotes");
    expect(cols).toContain("workability_facts");
  });

  it("evaluation_queue has available_at column from migration 004", async () => {
    const { rows } = await realPool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'evaluation_queue' AND column_name = 'available_at' AND table_schema = 'public'
    `);
    expect(rows).toHaveLength(1);
  });

  it("gate_decisions audit table exists from migration 004", async () => {
    const { rows } = await realPool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_name = 'gate_decisions' AND table_schema = 'public'
    `);
    expect(rows).toHaveLength(1);
  });

  it("raw_email_alerts has gmail_message_id column from migration 004", async () => {
    const { rows } = await realPool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'raw_email_alerts' AND column_name = 'gmail_message_id' AND table_schema = 'public'
    `);
    expect(rows).toHaveLength(1);
  });

  it("running migrations twice is idempotent (no rows re-applied)", async () => {
    const before = (await realPool.query(`SELECT COUNT(*)::int AS n FROM schema_migrations`)).rows[0].n;
    await runMigrations(realPool); // second run — should apply nothing
    const after = (await realPool.query(`SELECT COUNT(*)::int AS n FROM schema_migrations`)).rows[0].n;
    expect(after).toBe(before);
  });
});
