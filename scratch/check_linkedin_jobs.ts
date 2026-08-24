import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local", override: true });
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL + '?sslmode=require' });
async function run() {
  const linkedinJobs = await pool.query("SELECT COUNT(*) FROM jobs WHERE source = 'LinkedIn'");
  console.log(`LinkedIn jobs in final vault: ${linkedinJobs.rows[0].count}`);
  
  // also check if any of the 183 jobs from the json exist in jobs table
  // wait, I don't have the JSON. I can just see how many linkedin jobs we have total.
  process.exit(0);
}
run();
