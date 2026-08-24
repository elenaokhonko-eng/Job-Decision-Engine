import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local", override: true });
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL + '?sslmode=require' });
async function run() {
  const { rows } = await pool.query('SELECT core_fit_score, COUNT(*) FROM jobs WHERE final_classification IS NULL GROUP BY core_fit_score');
  console.log('Null final_classification jobs grouped by core_fit_score:', rows);
  process.exit(0);
}
run();
