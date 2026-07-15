import pg from "pg";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("❌ ERROR: DATABASE_URL environment variable is missing.");
  console.error("Please set it in your environment or in .env.local.");
  process.exit(1);
}

async function initDatabase() {
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

    console.log("Executing schema SQL...");
    await client.query(sql);
    console.log("✅ Schema initialized successfully!");
  } catch (err: any) {
    console.error("❌ Failed to initialize database:", err.message || err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

initDatabase();
