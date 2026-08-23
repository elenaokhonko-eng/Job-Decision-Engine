import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const notNullCount = await pool.query("SELECT COUNT(*) FROM jobs WHERE final_classification IS NOT NULL AND final_classification != 'UNASSIGNED'");
  console.log("Evaluated jobs (not null):", notNullCount.rows[0].count);
  process.exit(0);
}
run();
