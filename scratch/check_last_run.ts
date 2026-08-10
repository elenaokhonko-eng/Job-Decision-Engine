import pg from 'pg';
import dotenv from 'dotenv';
import { exec } from 'child_process';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  console.log("====================================================");
  console.log("       AUTO-RUN AND CRON EXECUTION CHECK            ");
  console.log("====================================================");

  try {
    // 1. Get recent evaluated jobs
    console.log("\nChecking recently evaluated jobs in 'jobs' table:");
    const resJobs = await pool.query(
      "SELECT title, company_name, status, created_at FROM jobs ORDER BY created_at DESC LIMIT 5"
    );
    resJobs.rows.forEach(r => {
      console.log(`- [${r.created_at.toLocaleString()}] ${r.company_name} | ${r.title} (${r.status})`);
    });

    // 2. Check latest raw email alerts
    console.log("\nChecking recently received email alerts in 'raw_email_alerts' table:");
    const resEmails = await pool.query(
      "SELECT subject, received_at, processed, processed_at FROM raw_email_alerts ORDER BY received_at DESC LIMIT 5"
    );
    resEmails.rows.forEach(r => {
      console.log(`- [${r.received_at.toLocaleString()}] ${r.subject} (Processed: ${r.processed}, At: ${r.processed_at ? r.processed_at.toLocaleString() : 'N/A'})`);
    });

    // 3. Count unprocessed
    const resUnprocessedEmails = await pool.query("SELECT COUNT(*) FROM raw_email_alerts WHERE processed = FALSE");
    console.log(`\nUnprocessed email alerts in DB: ${resUnprocessedEmails.rows[0].count}`);

    const resUnprocessedJobs = await pool.query("SELECT COUNT(*) FROM raw_jobs WHERE processed = FALSE");
    console.log(`Pending raw_jobs in DB: ${resUnprocessedJobs.rows[0].count}`);

  } catch (err: any) {
    console.error("Database query failed:", err.message);
  } finally {
    await pool.end();
  }

  // 4. Query Windows Task Scheduler via powershell
  console.log("\nQuerying Windows Task Scheduler for job-related tasks...");
  exec(
    `powershell -Command "Get-ScheduledTask | Where-Object { $_.TaskName -like '*job*' -or $_.TaskPath -like '*job*' } | Select-Object TaskName, State, @{Name='LastRunTime';Expression={(Get-ScheduledTaskInfo -TaskName $_.TaskName).LastRunTime}} | ConvertTo-Json"`,
    (err, stdout, stderr) => {
      if (err) {
        console.error("Task Scheduler query failed:", err.message);
        return;
      }
      try {
        const tasks = JSON.parse(stdout.trim());
        console.log("Found Scheduled Tasks:");
        console.log(JSON.stringify(tasks, null, 2));
      } catch {
        console.log("No specific scheduled tasks returned or output formatting differed.");
        console.log(stdout.trim());
      }
    }
  );
}

run().catch(err => console.error(err));
