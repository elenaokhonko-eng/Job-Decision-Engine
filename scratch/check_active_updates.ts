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
  const resRaw = await pool.query("SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM raw_jobs WHERE created_at >= NOW() - INTERVAL '30 minutes'");
  console.log(`Raw jobs staged in the last 30 minutes: ${resRaw.rows[0].count}`);
  console.log(`Min created_at: ${resRaw.rows[0].min}`);
  console.log(`Max created_at: ${resRaw.rows[0].max}`);
  
  const resEmails = await pool.query("SELECT COUNT(*) FROM raw_email_alerts WHERE processed = TRUE AND processed_at >= NOW() - INTERVAL '30 minutes'");
  console.log(`Emails processed in the last 30 minutes: ${resEmails.rows[0].count}`);

  const resJobs = await pool.query("SELECT COUNT(*) FROM jobs WHERE created_at >= NOW() - INTERVAL '30 minutes'");
  console.log(`Final jobs evaluated in the last 30 minutes: ${resJobs.rows[0].count}`);
  
  await pool.end();
}

run();
