import { describe, it, expect, vi } from "vitest";
import { runMigrations } from "../../db/migrate.js";

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
