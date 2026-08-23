import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const res = await pool.query(`
    SELECT title, description 
    FROM jobs 
    WHERE final_classification = 'REJECTED' 
    ORDER BY created_at DESC 
    LIMIT 2
  `);
  for (const row of res.rows) {
    console.log("TITLE:", row.title);
    console.log("DESC:", row.description);
    console.log("-------------");
  }
  process.exit(0);
}
run();
