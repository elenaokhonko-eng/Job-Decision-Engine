import pg from "pg";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;
const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl && (databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1")) ? false : { rejectUnauthorized: false }
});

async function checkJobs() {
  try {
    const rawJobsTotal = await pool.query("SELECT COUNT(*) FROM raw_jobs");
    const rawJobsProcessed = await pool.query("SELECT COUNT(*) FROM raw_jobs WHERE processed = TRUE");
    const rawJobsUnprocessed = await pool.query("SELECT COUNT(*) FROM raw_jobs WHERE processed = FALSE");

    console.log("=== RAW JOBS STAGING ===");
    console.log(`Total Staged Raw Jobs: ${rawJobsTotal.rows[0].count}`);
    console.log(`Processed Raw Jobs: ${rawJobsProcessed.rows[0].count}`);
    console.log(`Unprocessed Raw Jobs: ${rawJobsUnprocessed.rows[0].count}`);

    const finalJobsTotal = await pool.query("SELECT COUNT(*) FROM jobs");
    const evaluatedJobs = await pool.query("SELECT COUNT(*) FROM jobs WHERE status != 'UNASSIGNED'");
    const strongMatch = await pool.query("SELECT COUNT(*) FROM jobs WHERE status = 'STRONG MATCH'");
    const reviewRequired = await pool.query("SELECT COUNT(*) FROM jobs WHERE status = 'REVIEW REQUIRED'");
    const rejected = await pool.query("SELECT COUNT(*) FROM jobs WHERE status = 'REJECTED'");

    console.log("\n=== FINAL JOBS TABLE ===");
    console.log(`Total Final Jobs: ${finalJobsTotal.rows[0].count}`);
    console.log(`Evaluated (Assessed & Scored): ${evaluatedJobs.rows[0].count}`);
    console.log(`  - STRONG MATCH: ${strongMatch.rows[0].count}`);
    console.log(`  - REVIEW REQUIRED: ${reviewRequired.rows[0].count}`);
    console.log(`  - REJECTED: ${rejected.rows[0].count}`);

  } catch (err) {
    console.error("Error querying DB:", err);
  } finally {
    await pool.end();
  }
}

checkJobs();
