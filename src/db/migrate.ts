import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(clientOrPool: pg.Pool | pg.PoolClient): Promise<string[]> {
  const migrationsDir = path.resolve(__dirname, "../../migrations");
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  // 1. Ensure schema_migrations exists
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // 2. Fetch already applied migrations
  const { rows } = await clientOrPool.query(`SELECT version FROM schema_migrations ORDER BY version ASC`);
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
    const sqlContent = fs.readFileSync(filePath, "utf-8");

    // Execute in transaction
    await clientOrPool.query("BEGIN");
    try {
      await clientOrPool.query(sqlContent);
      await clientOrPool.query(
        `INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW())`,
        [file]
      );
      await clientOrPool.query("COMMIT");
      console.log(`✅ Applied migration: ${file}`);
      newlyApplied.push(file);
    } catch (err: any) {
      await clientOrPool.query("ROLLBACK");
      console.error(`❌ Migration failed on ${file}:`, err.message);
      throw err;
    }
  }

  return newlyApplied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && (process.env.DATABASE_URL.includes("localhost") || process.env.DATABASE_URL.includes("127.0.0.1")) ? false : { rejectUnauthorized: false }
  });

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
