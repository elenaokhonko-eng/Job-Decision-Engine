import pg from "pg";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

dotenv.config();
dotenv.config({ path: ".env.local" });

export async function runDeduplication() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn("⚠️ DATABASE_URL is not set. Skipping deduplication.");
    return;
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1") ? false : { rejectUnauthorized: false }
  });

  try {
    console.log("🧼 Running database deduplication checks on raw_jobs...");
    
    // 1. Delete exact duplicate URLs within raw_jobs (keep the oldest entry with smallest ID)
    const del1 = await pool.query(`
      DELETE FROM raw_jobs a
      USING raw_jobs b
      WHERE a.id > b.id
        AND a.careers_portal_url = b.careers_portal_url
        AND a.careers_portal_url IS NOT NULL
    `);
    
    // 2. Delete duplicate Title + Company within raw_jobs (keep the oldest entry with smallest ID)
    const del2 = await pool.query(`
      DELETE FROM raw_jobs a
      USING raw_jobs b
      WHERE a.id > b.id
        AND a.title = b.title
        AND a.company_name = b.company_name
    `);
    
    // 3. Delete any staging jobs that have already been evaluated and exist in the final jobs table
    const del3 = await pool.query(`
      DELETE FROM raw_jobs r
      WHERE EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.careers_portal_url = r.careers_portal_url
           OR (j.title = r.title AND j.company_name = r.company_name)
      )
    `);

    console.log("🧼 Deduplication results:");
    console.log(`  - Deleted ${del1.rowCount || 0} duplicate URLs in staging.`);
    console.log(`  - Deleted ${del2.rowCount || 0} duplicate title/company rows in staging.`);
    console.log(`  - Deleted ${del3.rowCount || 0} staging rows already evaluated in final table.`);
  } catch (error) {
    console.error("❌ Error running deduplication:", error);
  } finally {
    await pool.end();
  }
}

// Run directly if executed via CLI
const nodePath = process.argv[1];
if (nodePath && (nodePath.endsWith("deduplicate.ts") || nodePath.endsWith("deduplicate"))) {
  runDeduplication();
}
