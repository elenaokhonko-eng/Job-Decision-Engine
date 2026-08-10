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
  console.log("=== Inspecting Unprocessed Email Alerts ===");
  const res = await pool.query(`
    SELECT id, subject, received_at 
    FROM raw_email_alerts 
    WHERE processed = FALSE 
    ORDER BY received_at DESC 
    LIMIT 20
  `);
  
  res.rows.forEach((r, i) => {
    console.log(`${i+1}. [${r.received_at.toLocaleString()}] "${r.subject}" (ID: ${r.id})`);
  });

  await pool.end();
}

run();
