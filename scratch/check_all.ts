import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const res = await pool.query("SELECT id, title, company_name, final_classification, core_fit_score FROM jobs WHERE final_classification IS NOT NULL AND final_classification != 'UNASSIGNED'");
  console.log("Total matching rows:", res.rows.length);
  for (const row of res.rows) {
    console.log(`- ${row.title} @ ${row.company_name} | Status: ${row.final_classification} | Score: ${row.core_fit_score}`);
  }
  process.exit(0);
}
run();
