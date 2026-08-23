import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const res = await pool.query("SELECT * FROM jobs WHERE final_classification IN ('STRONG MATCH', 'PRIORITY_APPLY', 'HIGH_FIT_HIGH_RISK')");
  console.log("Total matched:", res.rows.length);
  for (const row of res.rows) {
    console.log(`- ${row.title} @ ${row.company_name} | Status: ${row.final_classification}`);
  }
  process.exit(0);
}
run();
