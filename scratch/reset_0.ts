import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const res = await pool.query("UPDATE jobs SET final_classification = NULL, core_fit_score = 0 WHERE final_classification IS NOT NULL AND core_fit_score = 0");
  console.log(res.rowCount + ' jobs reset');
  process.exit(0);
}
run();
