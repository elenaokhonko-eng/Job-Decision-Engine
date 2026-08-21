import pg from "pg";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("❌ ERROR: DATABASE_URL environment variable is missing.");
  process.exit(1);
}

async function applySchema() {
  console.log("Connecting to Postgres database...");
  const client = new pg.Client({
    connectionString: databaseUrl!,
    ssl: databaseUrl!.includes("localhost") || databaseUrl!.includes("127.0.0.1") ? false : { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log("Connected successfully!");

    const schemaPath = path.join(process.cwd(), "src", "db", "schema.sql");
    console.log(`Reading schema definitions from ${schemaPath}...`);
    const sql = fs.readFileSync(schemaPath, "utf-8");

    await client.query(sql);
    console.log("✅ Schema initialized successfully!");

    console.log("Resetting processed flag for all raw jobs...");
    const res = await client.query("UPDATE raw_jobs SET processed = FALSE");
    console.log(`✅ Reset ${res.rowCount} jobs in raw_jobs table to be re-processed.`);
    
    // Also check how many raw_jobs exist
    const countRes = await client.query("SELECT COUNT(*) FROM raw_jobs");
    console.log(`Total raw_jobs in staging: ${countRes.rows[0].count}`);
  } catch (err: any) {
    console.error("❌ Failed to initialize database:", err.message || err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

applySchema();
