import pg from "pg";
import dotenv from "dotenv";
import { getMigrationStatus, getMigrationsList } from "../src/db/migrate.js";
import { isPooledPostgresConnectionString, pgPoolConfig } from "../src/db/pgSsl.js";

// Load local configuration without replacing explicitly supplied CI/production variables.
dotenv.config();
dotenv.config({ path: ".env.local" });

export function compareMigrationLedger(
  repositoryMigrations: readonly string[],
  appliedMigrations: readonly string[],
): { readonly pending: readonly string[]; readonly unknown: readonly string[] } {
  const repositorySet = new Set(repositoryMigrations);
  const appliedSet = new Set(appliedMigrations);
  return {
    pending: repositoryMigrations.filter((migration) => !appliedSet.has(migration)),
    unknown: appliedMigrations.filter((migration) => !repositorySet.has(migration)),
  };
}

async function main(): Promise<void> {
  const databaseUrl = (process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required.");
  if (isPooledPostgresConnectionString(databaseUrl)) {
    throw new Error("Migration verification requires a direct, unpooled PostgreSQL connection.");
  }

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  try {
    const status = await getMigrationStatus(pool);
    if (!status.isInitialized) {
      throw new Error("Production migration verification found no initialized migration ledger.");
    }
    const ledger = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version ASC",
    );
    const comparison = compareMigrationLedger(getMigrationsList(), ledger.rows.map((row) => row.version));
    if (comparison.pending.length > 0 || comparison.unknown.length > 0) {
      throw new Error(
        `Migration ledger differs from repository. Pending: ${comparison.pending.join(", ") || "none"}; ` +
        `unknown: ${comparison.unknown.join(", ") || "none"}.`,
      );
    }
    console.log(JSON.stringify({
      event: "MIGRATION_LEDGER_VERIFIED",
      latestAppliedMigration: status.applied.at(-1) ?? null,
      appliedCount: status.appliedCount,
      pendingCount: status.pendingCount,
    }));
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("verify_migration_status.ts")) {
  main().catch((error: unknown) => {
    console.error("Migration ledger verification failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
