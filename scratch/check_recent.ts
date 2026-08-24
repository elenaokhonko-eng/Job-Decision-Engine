import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local", override: true });
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL + '?sslmode=require' });
async function run() {
  const recentRaw = await pool.query("SELECT COUNT(*) FROM raw_jobs WHERE created_at > NOW() - INTERVAL '30 minutes'");
  const unprocessedRaw = await pool.query("SELECT COUNT(*) FROM raw_jobs WHERE processed = FALSE");
  const totalRaw = await pool.query("SELECT COUNT(*) FROM raw_jobs");
  console.log(`Recent insertions in raw_jobs (last 30m): ${recentRaw.rows[0].count}`);
  console.log(`Total unprocessed jobs in raw_jobs: ${unprocessedRaw.rows[0].count}`);
  console.log(`Total jobs in raw_jobs: ${totalRaw.rows[0].count}`);
  process.exit(0);
}
run();
