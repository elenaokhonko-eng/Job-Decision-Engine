import { spawnSync } from "node:child_process";

import pg from "pg";
import dotenv from "dotenv";

import { pgSslConfig } from "../src/db/pgSsl.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

function isLocalDatabaseUrl(databaseUrl: string): boolean {
  try {
    const parsed = new URL(databaseUrl);
    const host = parsed.hostname.trim().toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return (
      databaseUrl.includes("localhost") ||
      databaseUrl.includes("127.0.0.1") ||
      databaseUrl.includes("::1")
    );
  }
}

function getDefaultDatabaseUrl(): string {
  const user = process.env.POSTGRES_USER ?? "jdec";
  const password = process.env.POSTGRES_PASSWORD ?? "jdec_password";
  const dbName = process.env.POSTGRES_DB ?? "jdec";
  const port = process.env.POSTGRES_PORT ?? "5432";

  const encodedUser = encodeURIComponent(user);
  const encodedPassword = encodeURIComponent(password);
  const encodedDbName = encodeURIComponent(dbName);

  return `postgresql://${encodedUser}:${encodedPassword}@localhost:${port}/${encodedDbName}?sslmode=disable`;
}

function dockerComposeUp(serviceName: string): void {
  const args = ["up", "-d", serviceName];
  const dockerComposeResult = spawnSync("docker", ["compose", ...args], { stdio: "inherit" });
  if (dockerComposeResult.status === 0) {
    return;
  }

  const legacyResult = spawnSync("docker-compose", args, { stdio: "inherit" });
  if (legacyResult.status === 0) {
    return;
  }

  if (dockerComposeResult.error) {
    throw dockerComposeResult.error;
  }
  if (legacyResult.error) {
    throw legacyResult.error;
  }

  process.exit(dockerComposeResult.status ?? legacyResult.status ?? 1);
}

async function waitForDatabase(databaseUrl: string, timeoutMs = 60_000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    const client = new pg.Client({
      connectionString: databaseUrl,
      ssl: pgSslConfig(databaseUrl)
    });

    try {
      await client.connect();
      await client.query("SELECT 1 AS ok");
      await client.end();
      return;
    } catch (err) {
      lastError = err;
      try {
        await client.end();
      } catch {
        // ignore
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  const message = (lastError as any)?.message ?? String(lastError);
  throw new Error(`Timed out waiting for Postgres to accept connections. Last error: ${message}`);
}

async function main(): Promise<void> {
  const explicitDatabaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (
    explicitDatabaseUrl &&
    !isLocalDatabaseUrl(explicitDatabaseUrl) &&
    String(process.env.ALLOW_DEV_SETUP_REMOTE_DB || "").trim().toLowerCase() !== "true"
  ) {
    console.error("DATABASE_URL points to a non-local host.");
    console.error("`npm run dev:setup` is intended to provision a local Docker Postgres instance.");
    console.error("Unset DATABASE_URL to use the local Docker defaults, or run `npm run db:init` explicitly.");
    console.error("To override this guard, set ALLOW_DEV_SETUP_REMOTE_DB=\"true\".");
    process.exit(1);
  }

  const databaseUrl = explicitDatabaseUrl || getDefaultDatabaseUrl();

  console.log("Starting local Postgres (pgvector) via Docker Compose...");
  dockerComposeUp("postgres");

  console.log("Waiting for Postgres to accept connections...");
  await waitForDatabase(databaseUrl);

  console.log("Initializing schema (canonical migration chain)...");
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: pgSslConfig(databaseUrl)
  });

  await client.connect();
  try {
    const { runMigrations } = await import("../src/db/migrate.js");
    const applied = await runMigrations(client);
    console.log(`✅ Database ready. Applied ${applied.length} migrations.`);
  } finally {
    await client.end();
  }

  if (!process.env.DATABASE_URL) {
    console.log("No DATABASE_URL detected. For local runs, set this in .env.local:");
    console.log(`DATABASE_URL="${databaseUrl}"`);
  }
}

main().catch((err) => {
  console.error("❌ Local setup failed:", err?.message ?? err);
  process.exit(1);
});
