import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const res = await pool.query(`
    UPDATE jobs 
    SET 
      politics_stress_score = NULL,
      nd_friendly_score = NULL
    WHERE final_classification IS NULL
  `);
  console.log(res.rowCount + ' jobs reset to clear old toxicity scores');
  process.exit(0);
}
run();
