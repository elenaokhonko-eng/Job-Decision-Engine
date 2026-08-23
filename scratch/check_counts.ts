import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const rawJobsCount = await pool.query("SELECT COUNT(*) FROM raw_jobs");
  const jobsCount = await pool.query("SELECT COUNT(*) FROM jobs");
  console.log("Raw jobs (staging) count:", rawJobsCount.rows[0].count);
  console.log("Evaluated jobs (final) count:", jobsCount.rows[0].count);
  process.exit(0);
}
run();
