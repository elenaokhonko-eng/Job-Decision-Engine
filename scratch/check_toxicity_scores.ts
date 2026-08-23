import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const res = await pool.query(`
    SELECT title, company_name, core_fit_score, nd_friendly_score, politics_stress_score, final_classification 
    FROM jobs 
    WHERE final_classification IS NOT NULL AND final_classification != 'REJECTED' 
    ORDER BY created_at DESC 
    LIMIT 20
  `);
  console.table(res.rows);
  
  const counts = await pool.query(`
    SELECT 
      COUNT(*) as total,
      COUNT(nd_friendly_score) as with_nd_score,
      COUNT(politics_stress_score) as with_politics_score
    FROM jobs 
    WHERE final_classification IS NOT NULL AND final_classification != 'REJECTED'
  `);
  console.table(counts.rows);
  
  process.exit(0);
}
run();
