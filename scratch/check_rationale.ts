import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const res = await pool.query("SELECT id, title, company_name, final_classification, core_fit_score, is_top_ten FROM jobs WHERE evaluation_rationale ILIKE '%Accenture%'");
  console.log("Total matching rows:", res.rows.length);
  for (const row of res.rows) {
    console.log(`- ${row.title} @ ${row.company_name} | Status: ${row.final_classification} | Score: ${row.core_fit_score} | Top 10: ${row.is_top_ten}`);
  }
  process.exit(0);
}
run();
