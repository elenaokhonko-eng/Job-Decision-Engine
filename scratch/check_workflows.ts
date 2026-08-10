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
  console.log("=== Grouping unprocessed emails by received date ===");
  const res = await pool.query(`
    SELECT DATE(received_at) as r_date, COUNT(*) as cnt 
    FROM raw_email_alerts 
    WHERE processed = FALSE 
    GROUP BY DATE(received_at) 
    ORDER BY r_date ASC
  `);
  res.rows.forEach(r => {
    console.log(`- Date: ${r.r_date.toLocaleDateString()} | Count: ${r.cnt}`);
  });

  console.log("\n=== Checking if there are any unprocessed raw_jobs ===");
  const resRaw = await pool.query("SELECT id, title, company_name, created_at FROM raw_jobs WHERE processed = FALSE");
  console.log(`Found ${resRaw.rows.length} unprocessed staging raw_jobs.`);
  resRaw.rows.forEach(r => {
    console.log(`- [${r.created_at.toLocaleString()}] ${r.company_name} | ${r.title}`);
  });

  await pool.end();
}

run();
