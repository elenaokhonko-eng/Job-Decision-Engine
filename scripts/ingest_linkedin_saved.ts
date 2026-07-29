import fs from "fs";
import path from "path";
import pg from "pg";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;

async function ingestLinkedInSavedJobs() {
  console.log("====================================================");
  console.log("    INGEST LINKEDIN SAVED JOBS TO STAGING DATABASE   ");
  console.log("====================================================");

  if (!databaseUrl) {
    console.error("❌ ERROR: DATABASE_URL environment variable is missing.");
    process.exit(1);
  }

  const filePath = path.join(process.cwd(), "linkedin_saved_jobs.json");
  if (!fs.existsSync(filePath)) {
    console.error(`❌ ERROR: Could not find "linkedin_saved_jobs.json" in the project root.`);
    console.log("Please export your saved jobs from the browser console and save the file in this folder.");
    process.exit(1);
  }

  let jobs: any[] = [];
  try {
    const rawData = fs.readFileSync(filePath, "utf-8");
    jobs = JSON.parse(rawData);
    if (!Array.isArray(jobs)) {
      throw new Error("JSON root element is not an array");
    }
  } catch (err: any) {
    console.error("❌ ERROR: Failed to parse linkedin_saved_jobs.json:", err.message || err);
    process.exit(1);
  }

  console.log(`Found ${jobs.length} jobs in "linkedin_saved_jobs.json". Connecting to database...`);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1") ? false : { rejectUnauthorized: false }
  });

  let insertedCount = 0;
  let skippedCount = 0;

  try {
    for (const job of jobs) {
      const title = job.title?.trim();
      const company = job.company?.trim();
      const url = job.url?.trim();
      const description = job.description?.trim();
      const location = job.location?.trim() || "Singapore";
      const salary = job.salary?.trim() || null;

      if (!title || !company || !url || !description) {
        console.warn(`⚠️ Skipping invalid job item (missing title, company, url, or description):`, job);
        skippedCount++;
        continue;
      }

      // Check if job already exists in raw_jobs (staging) or jobs (final) to prevent duplicates
      const checkRaw = await pool.query(
        "SELECT id FROM raw_jobs WHERE careers_portal_url = $1 OR (title = $2 AND company_name = $3)",
        [url, title, company]
      );
      const checkFinal = await pool.query(
        "SELECT id FROM jobs WHERE careers_portal_url = $1 OR (title = $2 AND company_name = $3)",
        [url, title, company]
      );

      if (checkRaw.rows.length > 0 || checkFinal.rows.length > 0) {
        skippedCount++;
        continue;
      }

      // Insert job into raw_jobs staging table
      await pool.query(
        `INSERT INTO raw_jobs 
         (company_name, title, source, raw_description, salary_range, location, careers_portal_url, processed) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)`,
        [company, title, "LinkedIn", description, salary, location, url]
      );

      insertedCount++;
    }

    console.log(`\n✅ Ingestion completed!`);
    console.log(`- Successfully inserted: ${insertedCount} jobs`);
    console.log(`- Skipped (duplicates or invalid): ${skippedCount} jobs`);
  } catch (err: any) {
    console.error("❌ Database query error:", err.message || err);
  } finally {
    await pool.end();
  }
}

ingestLinkedInSavedJobs();
