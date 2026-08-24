import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local", override: true });
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL + '?sslmode=require' });
async function run() {
  const { rows } = await pool.query('SELECT stage1_status, COUNT(*) FROM jobs WHERE final_classification IS NULL GROUP BY stage1_status');
  console.log('Null final_classification jobs grouped by stage1_status:', rows);
  process.exit(0);
}
run();
