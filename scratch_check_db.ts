import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false }
});

  try {
    await pool.query("UPDATE raw_email_alerts SET processed = FALSE");
    const rawEmail = await pool.query("SELECT COUNT(*) FROM raw_email_alerts WHERE processed = FALSE");
    const rawJobs = await pool.query("SELECT COUNT(*) FROM raw_jobs WHERE processed = FALSE");
    const jobs = await pool.query("SELECT COUNT(*) FROM jobs");
    console.log("Unprocessed Raw Email Alerts:", rawEmail.rows[0].count);
    console.log("Unprocessed Raw Jobs:", rawJobs.rows[0].count);
    console.log("Jobs:", jobs.rows[0].count);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

checkJobs();
