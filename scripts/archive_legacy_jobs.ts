import pg from "pg";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("❌ ERROR: DATABASE_URL environment variable is missing.");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1") ? false : { rejectUnauthorized: false }
});

async function archiveLegacyTables() {
  console.log("Starting controlled reset of database schema...");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Check if jobs table exists
    const jobsExist = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'jobs'
      );
    `);

    if (jobsExist.rows[0].exists) {
      console.log("Archiving 'jobs' table to 'archived_jobs'...");
      await client.query("DROP TABLE IF EXISTS archived_jobs CASCADE;");
      await client.query("ALTER TABLE jobs RENAME TO archived_jobs;");
    } else {
      console.log("'jobs' table not found, skipping archive.");
    }

    // Check if raw_jobs table exists
    const rawJobsExist = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'raw_jobs'
      );
    `);

    if (rawJobsExist.rows[0].exists) {
      console.log("Archiving 'raw_jobs' table to 'archived_raw_jobs'...");
      await client.query("DROP TABLE IF EXISTS archived_raw_jobs CASCADE;");
      await client.query("ALTER TABLE raw_jobs RENAME TO archived_raw_jobs;");
    } else {
      console.log("'raw_jobs' table not found, skipping archive.");
    }

    await client.query("COMMIT");
    console.log("✅ Successfully archived legacy tables.");
  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to archive legacy tables:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

archiveLegacyTables();
