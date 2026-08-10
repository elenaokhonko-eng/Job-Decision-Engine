import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  console.log("=== Staging & Processing Status ===");
  
  // Unprocessed email alerts count
  const resEmail = await pool.query("SELECT COUNT(*) as cnt FROM raw_email_alerts WHERE processed = FALSE");
  console.log(`Unprocessed email alerts remaining: ${resEmail.rows[0].cnt}`);

  // Unprocessed raw jobs count
  const resRaw = await pool.query("SELECT COUNT(*) as cnt FROM raw_jobs WHERE processed = FALSE");
  console.log(`Unprocessed raw jobs remaining: ${resRaw.rows[0].cnt}`);

  // Latest processed email alert
  const resLatestEmail = await pool.query("SELECT subject, received_at, processed_at FROM raw_email_alerts WHERE processed = TRUE ORDER BY processed_at DESC LIMIT 3");
  console.log("\n=== Latest Processed Email Alerts ===");
  resLatestEmail.rows.forEach(r => {
    console.log(`- Subject: "${r.subject}" | Received: ${r.received_at.toLocaleString()} | Processed: ${r.processed_at.toLocaleString()}`);
  });

  // Jobs created/processed today (August 3, 2026)
  const resJobsToday = await pool.query("SELECT title, company_name, status, total_score, created_at FROM jobs WHERE created_at >= '2026-08-03 00:00:00' ORDER BY created_at DESC");
  console.log(`\n=== Jobs Evaluated/Created Today (August 3, 2026) ===`);
  console.log(`Total: ${resJobsToday.rows.length}`);
  resJobsToday.rows.slice(0, 10).forEach(r => {
    console.log(`- [${r.created_at.toLocaleString()}] ${r.company_name} | ${r.title} | Status: ${r.status} | Score: ${r.total_score}/100`);
  });

  await pool.end();
}

run();
