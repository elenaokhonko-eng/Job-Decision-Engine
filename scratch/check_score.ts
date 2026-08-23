import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const res = await pool.query("SELECT title, final_classification, core_fit_score, score_hands_on_mastery FROM jobs WHERE company_name = 'Databricks'");
  console.log(res.rows);
  process.exit(0);
}
run();
