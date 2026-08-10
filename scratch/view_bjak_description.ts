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
  const res = await pool.query("SELECT raw_description FROM jobs WHERE company_name = 'BJAK' AND title = 'Technical Product Manager'");
  console.log(`Matching records in jobs: ${res.rows.length}`);
  if (res.rows.length > 0) {
    const raw = res.rows[0].raw_description;
    console.log(`Type of raw_description: ${typeof raw}`);
    console.log(`Raw value (first 500 chars):`);
    console.log(JSON.stringify(raw).substring(0, 500));
  }
  await pool.end();
}

run();
