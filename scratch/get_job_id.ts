import pg from "pg";
import dotenv from "dotenv";
import { execSync } from "child_process";

dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const res = await pool.query("SELECT id FROM canonical_jobs LIMIT 1");
  const id = res.rows[0].id;
  console.log("Found Job ID:", id);
  console.log("Running CV Generator...");
  execSync(`npx tsx scripts/generate_cv.ts ${id}`, { stdio: 'inherit' });
  process.exit(0);
}
run();
