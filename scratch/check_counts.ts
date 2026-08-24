import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local", override: true });
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL + '?sslmode=require' });
async function run() {
  const { rows } = await pool.query('SELECT final_classification, COUNT(*) FROM jobs GROUP BY final_classification');
  console.log('Jobs grouping by final_classification:', rows);
  
  const { rows: rawRows } = await pool.query('SELECT processed, COUNT(*) FROM raw_jobs GROUP BY processed');
  console.log('Raw jobs grouping by processed:', rawRows);
  
  process.exit(0);
}
run();
