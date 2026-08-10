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
  console.log("Checking insertion times (created_at) for unprocessed alerts...");
  const res = await pool.query("SELECT MIN(created_at) as min_c, MAX(created_at) as max_c FROM raw_email_alerts WHERE processed = FALSE");
  console.log(`Unprocessed alerts inserted between:`);
  console.log(`  - MIN: ${res.rows[0].min_c ? res.rows[0].min_c.toLocaleString() : 'N/A'}`);
  console.log(`  - MAX: ${res.rows[0].max_c ? res.rows[0].max_c.toLocaleString() : 'N/A'}`);
  await pool.end();
}

run();
