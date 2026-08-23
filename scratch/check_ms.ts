import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const res = await pool.query(`
    SELECT title, company_name, final_classification, core_fit_score, biological_stress_risk 
    FROM jobs 
    WHERE company_name ILIKE '%microsoft%'
  `);
  console.log(res.rows);
  process.exit(0);
}
run();
