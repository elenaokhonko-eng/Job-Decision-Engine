import pg from "pg";
import dotenv from "dotenv";
import { isPooledPostgresConnectionString, pgConnectionConfig } from "../src/db/pgSsl.js";

// Preserve explicitly injected CI/production variables while keeping local CLI
// execution consistent with the rest of the database tooling.
dotenv.config();
dotenv.config({ path: ".env.local" });

export function resolveMigrationDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const applicationUrl = String(env.DATABASE_URL || "").trim();
  const directUrl = String(env.DATABASE_URL_UNPOOLED || "").trim();

  if (!applicationUrl && !directUrl) {
    throw new Error(
      "Database preflight failed: DATABASE_URL is missing. Configure the GitHub Actions DATABASE_URL secret."
    );
  }

  if (directUrl && isPooledPostgresConnectionString(directUrl)) {
    throw new Error(
      "Database preflight failed: DATABASE_URL_UNPOOLED points to a Neon pooler. Configure it with the direct (unpooled) Neon connection string."
    );
  }

  if (isPooledPostgresConnectionString(applicationUrl) && !directUrl) {
    throw new Error(
      "Database preflight failed: DATABASE_URL is pooled and DATABASE_URL_UNPOOLED is missing. Migration and advisory-lock workflows require the direct Neon connection string."
    );
  }

  return directUrl || applicationUrl;
}

export async function preflightDatabase(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ database: string; schema: string; serverVersion: string }> {
  const connectionString = resolveMigrationDatabaseUrl(env);
  const client = new pg.Client(pgConnectionConfig(connectionString));

  try {
    await client.connect();
    const result = await client.query<{
      database: string;
      schema: string;
      server_version: string;
    }>(
      `SELECT current_database() AS database,
              current_schema() AS schema,
              current_setting('server_version') AS server_version`
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Database preflight failed: PostgreSQL returned no identity row.");
    }
    return {
      database: row.database,
      schema: row.schema,
      serverVersion: row.server_version,
    };
  } catch (error: any) {
    const message = error?.message || String(error);
    throw new Error(`Database preflight failed: unable to connect to the configured PostgreSQL database: ${message}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1]?.endsWith("preflight_database.ts")) {
  preflightDatabase()
    .then((result) => {
      console.log(
        `Database preflight passed: database=${result.database} schema=${result.schema} server=${result.serverVersion}`
      );
    })
    .catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
}
