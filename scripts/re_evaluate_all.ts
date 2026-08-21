import pg from "pg";
import dotenv from "dotenv";
import { execSync } from "child_process";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl && (databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1")) ? false : { rejectUnauthorized: false }
});

async function reEvaluateAll() {
  console.log("====================================================");
  console.log("      DATABASE RE-EVALUATION PIPELINE SCRIPT       ");
  console.log("====================================================");

  if (!databaseUrl) {
    console.error("❌ ERROR: DATABASE_URL environment variable is missing.");
    process.exit(1);
  }

  try {
    // 1. Fetch all existing evaluated jobs
    console.log("Fetching all existing evaluated jobs...");
    const jobsRes = await pool.query("SELECT * FROM jobs");
    console.log(`Found ${jobsRes.rows.length} jobs to re-evaluate.`);

    if (jobsRes.rows.length === 0) {
      console.log("No jobs found in the final jobs table. Assuming they are already in raw_jobs or DB is empty.");
    } else {
      let migratedCount = 0;
      // 2. Insert them back into raw_jobs as unprocessed
      for (const job of jobsRes.rows) {
        // We only insert if it doesn't already exist in raw_jobs
        const checkRaw = await pool.query(
          "SELECT id FROM raw_jobs WHERE careers_portal_url = $1 OR (title = $2 AND company_name = $3)",
          [job.careers_portal_url, job.title, job.company_name]
        );

        if (checkRaw.rows.length === 0) {
          await pool.query(
            `INSERT INTO raw_jobs 
             (company_name, title, source, raw_description, salary_range, location, careers_portal_url, posted_date, processed) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE)`,
            [
              job.company_name, 
              job.title, 
              job.source || 'LinkedIn', 
              job.raw_description || job.description || '', 
              job.salary_range, 
              job.location, 
              job.careers_portal_url, 
              job.posted_date || new Date().toISOString().split('T')[0]
            ]
          );
          migratedCount++;
        } else {
          // If it exists, ensure it is set to unprocessed
          await pool.query(
            "UPDATE raw_jobs SET processed = FALSE WHERE id = $1",
            [checkRaw.rows[0].id]
          );
        }
      }
      console.log(`Migrated ${migratedCount} jobs back to staging (raw_jobs).`);

      // 3. Clear the final jobs table
      console.log("Clearing existing evaluated records from jobs table...");
      await pool.query("DELETE FROM jobs");
      console.log("jobs table cleared.");
    }

    console.log("\n====================================================");
    console.log("Triggering the main evaluation pipeline...");
    console.log("====================================================\n");

    // 4. Run evaluate_jobs.ts
    execSync("npx tsx scripts/evaluate_jobs.ts", { stdio: "inherit" });

    console.log("\n✅ Re-evaluation complete!");

  } catch (err: any) {
    console.error("❌ Error during re-evaluation:", err.message || err);
  } finally {
    await pool.end();
  }
}

reEvaluateAll();
