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
  const res = await pool.query(
    "SELECT id, company_name, title, careers_portal_url, status FROM jobs WHERE company_name ILIKE '%microsoft%' OR company_name ILIKE '%amazon%' OR company_name ILIKE '%aws%'"
  );
  console.log(JSON.stringify(res.rows, null, 2));
  await pool.end();
}

run();
