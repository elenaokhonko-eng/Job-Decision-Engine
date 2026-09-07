import pg from "pg";
import dotenv from "dotenv";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool(pgConnectionConfig(process.env.DATABASE_URL));

async function main() {
  await pool.query("DELETE FROM jobs WHERE created_at >= NOW() - INTERVAL '10 minutes' AND total_score = 0 AND status = 'REJECTED'");
  await pool.query("UPDATE raw_email_alerts SET processed = FALSE WHERE processed_at >= NOW() - INTERVAL '10 minutes'");
  console.log("Reset bad jobs and email alerts.");
  process.exit(0);
}
main();
