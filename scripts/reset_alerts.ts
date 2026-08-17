import pg from "pg";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false }
});

async function main() {
  await pool.query("UPDATE raw_email_alerts SET processed = FALSE WHERE processed_at >= NOW() - INTERVAL '1 hour'");
  console.log("Reset processed flag.");
  process.exit(0);
}
main();
