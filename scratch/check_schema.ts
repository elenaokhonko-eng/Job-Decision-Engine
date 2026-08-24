import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local", override: true });
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL + '?sslmode=require' });
async function run() {
  const { rows } = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'jobs'");
  console.log(rows.map(r => r.column_name));
  
  // also check if status still exists and has data
  try {
     const { rows: stats } = await pool.query("SELECT status, COUNT(*) FROM jobs GROUP BY status");
     console.log('Jobs grouping by status:', stats);
  } catch(e: any) {
     console.log('No status column:', e.message);
  }
  process.exit(0);
}
run();
