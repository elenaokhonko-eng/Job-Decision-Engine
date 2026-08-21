import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false }
});

async function checkJobs() {
  try {
    const res = await pool.query("SELECT processed, count(*) FROM raw_email_alerts GROUP BY processed;");
    console.log("raw_email_alerts processed status counts:");
    console.table(res.rows);

    const jobsCols = await pool.query("SELECT * FROM jobs LIMIT 1;");
    console.log("jobs Columns:", Object.keys(jobsCols.rows[0] || {}));
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

checkJobs();
