import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { getMigrationsList } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgPoolConfig } from "../../db/pgSsl.js";
import {
  duplicateMigrationPrefixes,
  invalidNewMigrationNames,
  migrationsAtOrBelowBaseline,
} from "../../db/migrationOrdering.js";

const databaseUrl = process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

let pool: pg.Pool | undefined;

describe.skipIf(skipReal)("migration ordering against the CI baseline database", () => {
  beforeAll(() => {
    pool = new pg.Pool(pgPoolConfig(databaseUrl));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("keeps every pending migration above the highest applied baseline number", async () => {
    if (!pool) throw new Error("The migration-order database pool was not initialized.");
    const { rows } = await pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version ASC`
    );
    const appliedMigrations = rows.map((row) => row.version);
    expect(appliedMigrations.length, "CI must seed schema_migrations from the target branch before this check").toBeGreaterThan(0);

    const currentMigrations = getMigrationsList();
    const applied = new Set(appliedMigrations);
    const pending = currentMigrations.filter((file) => !applied.has(file));
    expect(invalidNewMigrationNames(pending)).toEqual([]);
    expect(migrationsAtOrBelowBaseline(pending, appliedMigrations)).toEqual([]);
    expect(duplicateMigrationPrefixes(pending)).toEqual([]);
  });
});
