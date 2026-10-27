import pg from "pg";
import dotenv from "dotenv";
import { getMigrationStatus } from "../src/db/migrate.js";
import { isPooledPostgresConnectionString, pgPoolConfig } from "../src/db/pgSsl.js";

// Load local configuration without replacing explicitly supplied CI/production variables.
dotenv.config();
dotenv.config({ path: ".env.local" });

async function main(): Promise<void> {
  const databaseUrl = (process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required.");
  if (isPooledPostgresConnectionString(databaseUrl)) {
    throw new Error("Migration verification requires a direct, unpooled PostgreSQL connection.");
  }

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  try {
    const status = await getMigrationStatus(pool);
    if (status.pendingCount > 0) {
      throw new Error(`Production migration verification found pending migrations: ${status.pending.join(", ")}.`);
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

main().catch((error: unknown) => {
  console.error("Migration ledger verification failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
