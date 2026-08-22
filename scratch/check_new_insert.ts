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
  console.log("Checking if BJAK job exists in processed 'jobs' table...");
  const resBjakProcessed = await pool.query("SELECT id, title, company_name, final_classification, total_score, created_at FROM jobs WHERE company_name ILIKE '%BJAK%'");
  if (resBjakProcessed.rows.length > 0) {
    console.log(`✅ YES, BJAK is in the processed 'jobs' table:`);
    resBjakProcessed.rows.forEach(r => {
      console.log(`  - [${r.created_at.toLocaleString()}] ${r.company_name} | ${r.title} (Status: ${r.final_classification}, Score: ${r.total_score}/100)`);
    });
  } else {
    console.log(`❌ NO, BJAK is NOT in the processed 'jobs' table yet.`);
  }

  console.log("\nChecking raw_jobs for BJAK state...");
  const resBjakRaw = await pool.query("SELECT id, title, company_name, processed, created_at FROM raw_jobs WHERE company_name ILIKE '%BJAK%'");
  resBjakRaw.rows.forEach(r => {
    console.log(`  - [${r.created_at.toLocaleString()}] ${r.company_name} | ${r.title} (processed: ${r.processed})`);
  });

  console.log("\nChecking total jobs processed or added TODAY (August 2, 2026)...");
  // In jobs table:
  const resJobsToday = await pool.query("SELECT title, company_name, final_classification, created_at FROM jobs WHERE created_at >= '2026-08-02 00:00:00' ORDER BY created_at DESC");
  console.log(`Found ${resJobsToday.rows.length} jobs created/processed in the final 'jobs' table today:`);
  resJobsToday.rows.forEach(r => {
    console.log(`  - [${r.created_at.toLocaleString()}] ${r.company_name} | ${r.title} (${r.final_classification})`);
  });

  await pool.end();
}

run();
