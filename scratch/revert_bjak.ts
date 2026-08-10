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
  const res = await pool.query("SELECT id, company_name, title, processed FROM raw_jobs ORDER BY created_at DESC");
  console.log(`Staging raw_jobs total rows: ${res.rows.length}`);
  res.rows.forEach((r, i) => {
    console.log(`[${i}] ID: ${r.id} | Company: "${r.company_name}" | Title: "${r.title}" | Processed: ${r.processed}`);
  });
  await pool.end();
}

run();
