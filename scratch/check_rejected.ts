import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const res = await pool.query(`
    SELECT title, biological_stress_risk 
    FROM jobs 
    WHERE final_classification = 'REJECTED' 
    ORDER BY created_at DESC 
    LIMIT 10
  `);
  console.log(res.rows);
  process.exit(0);
}
run();
