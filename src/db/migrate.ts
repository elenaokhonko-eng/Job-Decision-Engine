import pg from "pg";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isPooledPostgresConnectionString, pgPoolConfig } from "./pgSsl.js";

// Keep local CLI execution consistent with the other database scripts while
// preserving explicitly supplied CI/production environment variables.
dotenv.config();
dotenv.config({ path: ".env.local" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_LOCK_NAMESPACE = "job_decision_engine_migrations";

function isPool(value: pg.Pool | pg.PoolClient | pg.Client): value is pg.Pool {
  const maybe: any = value as any;
  return (
    typeof maybe?.connect === "function" &&
    typeof maybe?.query === "function" &&
    // pg.Pool exposes these counters; pg.Client does not.
    "totalCount" in maybe &&
    "idleCount" in maybe &&
    "waitingCount" in maybe
  );
}

export async function runMigrations(clientOrPool: pg.Pool | pg.PoolClient | pg.Client): Promise<string[]> {
  const migrationsDir = path.resolve(__dirname, "../../migrations");
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  const pool = clientOrPool;
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  try {
    // Prevent concurrent migration runs (Vitest runs test files in parallel; so do Actions workflows).
    // Advisory locks are session-scoped, so we must run on a single client connection.
    // Serialize per-schema migration runs. Many CI tests run migrations against isolated schemas in parallel.
    // Using `current_schema()` avoids cross-schema contention while still preventing public-schema races.
    await client.query(
      `SELECT pg_advisory_lock(hashtext($1), hashtext(current_schema()))`,
      [MIGRATIONS_LOCK_NAMESPACE]
    );

    // 1. Ensure schema_migrations exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 2. Fetch already applied migrations
    const { rows } = await client.query(`SELECT version FROM schema_migrations ORDER BY version ASC`);
    const applied = new Set(rows.map((r) => r.version));

    // 3. Read migration files in ascending order
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql") && !f.startsWith("."))
      .sort();

    const newlyApplied: string[] = [];

    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }

      console.log(`Applying migration: ${file}...`);
      const filePath = path.join(migrationsDir, file);
      // PostgreSQL treats a UTF-8 BOM as SQL input, so remove it defensively.
      const sqlContent = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");

      // Execute in transaction
      await client.query("BEGIN");
      try {
        await client.query(sqlContent);
        await client.query(`INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW())`, [file]);
        await client.query("COMMIT");
        console.log(`✅ Applied migration: ${file}`);
        newlyApplied.push(file);
      } catch (err: any) {
        await client.query("ROLLBACK");
        console.error(`❌ Migration failed on ${file}:`, err.message);
        throw err;
      }
    }

    return newlyApplied;
  } finally {
    await client
      .query(`SELECT pg_advisory_unlock(hashtext($1), hashtext(current_schema()))`, [MIGRATIONS_LOCK_NAMESPACE])
      .catch(() => undefined);
    if (ownsClient && typeof (client as any).release === "function") {
      (client as pg.PoolClient).release();
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const migrationDatabaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (isPooledPostgresConnectionString(migrationDatabaseUrl)) {
    throw new Error(
      "Migration runner requires DATABASE_URL_UNPOOLED when DATABASE_URL points to a pooled endpoint."
    );
  }
  const pool = new pg.Pool(pgPoolConfig(migrationDatabaseUrl));


  runMigrations(pool)
    .then((applied) => {
      console.log(`Migration runner finished. Applied ${applied.length} migrations.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Migration runner failed:", err);
      process.exit(1);
    });
}
