import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const emailsUnprocessed = await pool.query("SELECT count(*) FROM raw_email_alerts WHERE processed = false;");
  const emailsProcessed = await pool.query("SELECT count(*) FROM raw_email_alerts WHERE processed = true;");
  const rawJobsTotal = await pool.query("SELECT count(*) FROM raw_jobs;");
  const rawJobsUnprocessed = await pool.query("SELECT count(*) FROM raw_jobs WHERE processed = false;");
  const jobsEvaluatedToday = await pool.query("SELECT count(*) FROM jobs WHERE created_at >= '2026-08-22';");

  console.log(`Unprocessed Emails left: ${emailsUnprocessed.rows[0].count}`);
  console.log(`Processed Emails Total: ${emailsProcessed.rows[0].count}`);
  console.log(`Total Raw Jobs in DB: ${rawJobsTotal.rows[0].count}`);
  console.log(`Raw Jobs pending evaluation: ${rawJobsUnprocessed.rows[0].count}`);
  console.log(`Jobs fully evaluated today: ${jobsEvaluatedToday.rows[0].count}`);
  await pool.end();
}
run().catch(console.error);
