import fs from "fs";
import pg from "pg";
import dotenv from "dotenv";
import { pgConnectionConfig } from "../src/db/pgSsl.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;

const pool = new pg.Pool(pgConnectionConfig(databaseUrl));

async function runMigration() {
  try {
    const sql = fs.readFileSync("migrations/stage0_discovery.sql", "utf-8");
    console.log("Running migration...");
    await pool.query(sql);
    console.log("Migration applied successfully.");
  } catch (err: any) {
    console.error("Migration failed", err);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

runMigration();
