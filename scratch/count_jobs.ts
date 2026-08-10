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
  console.log("=== Source breakdown in 'jobs' ===");
  const resSource = await pool.query("SELECT source, COUNT(*) as cnt FROM jobs GROUP BY source");
  resSource.rows.forEach(r => {
    console.log(`- ${r.source}: ${r.cnt}`);
  });

  console.log("\n=== Source breakdown in 'raw_jobs' ===");
  const resRawSource = await pool.query("SELECT source, COUNT(*) as cnt FROM raw_jobs GROUP BY source");
  resRawSource.rows.forEach(r => {
    console.log(`- ${r.source}: ${r.cnt}`);
  });

  console.log("\n=== Recently added evaluated jobs (last 3 days) ===");
  const resRecent = await pool.query(
    "SELECT title, company_name, source, status, created_at FROM jobs WHERE created_at > NOW() - INTERVAL '3 days' ORDER BY created_at DESC"
  );
  console.log(`Found ${resRecent.rows.length} jobs created in the last 3 days:`);
  resRecent.rows.slice(0, 10).forEach(r => {
    console.log(`- [${r.created_at.toLocaleString()}] ${r.company_name} | ${r.title} (${r.status}) via ${r.source}`);
  });

  await pool.end();
}

run();
