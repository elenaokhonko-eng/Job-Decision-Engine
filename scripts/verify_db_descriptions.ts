import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("❌ ERROR: DATABASE_URL is missing.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  console.log("====================================================");
  console.log("       NEON POSTGRES DB INTEGRITY & SCHEMA CHECK     ");
  console.log("====================================================");

  try {
    // 1. Check jobs table descriptions
    console.log("Checking descriptions in 'jobs' table...");
    const jobsRes = await pool.query("SELECT id, company_name, title, raw_description FROM jobs");
    console.log(`Found ${jobsRes.rows.length} total records in 'jobs' table.`);

    let jobsFixed = 0;
    for (const row of jobsRes.rows) {
      let desc = row.raw_description;
      let needsFix = false;
      let parsed: any = null;

      if (!desc) {
        needsFix = true;
        parsed = {
          job_description: "No description available.",
          key_responsibilities: [],
          technical_skills: [],
          qualifications_education: [],
          nice_to_haves: []
        };
      } else if (typeof desc === 'string') {
        let trimmed = desc.trim();
        if (trimmed.startsWith('{')) {
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            needsFix = true;
            parsed = {
              job_description: desc,
              key_responsibilities: [],
              technical_skills: [],
              qualifications_education: [],
              nice_to_haves: []
            };
          }
        } else {
          needsFix = true;
          parsed = {
            job_description: desc,
            key_responsibilities: [],
            technical_skills: [],
            qualifications_education: [],
            nice_to_haves: []
          };
        }
      } else if (typeof desc === 'object') {
        parsed = desc;
        // Make sure all required fields are present
        if (
          !('job_description' in parsed) ||
          !('key_responsibilities' in parsed) ||
          !('technical_skills' in parsed) ||
          !('qualifications_education' in parsed) ||
          !('nice_to_haves' in parsed)
        ) {
          needsFix = true;
          parsed = {
            job_description: parsed.job_description || "No description available.",
            key_responsibilities: parsed.key_responsibilities || [],
            technical_skills: parsed.technical_skills || [],
            qualifications_education: parsed.qualifications_education || [],
            nice_to_haves: parsed.nice_to_haves || []
          };
        }
      }

      if (needsFix && parsed) {
        await pool.query(
          "UPDATE jobs SET raw_description = $1 WHERE id = $2",
          [JSON.stringify(parsed), row.id]
        );
        jobsFixed++;
      }
    }
    console.log(`✅ Finished checking 'jobs' table. Fixed/standardized: ${jobsFixed} rows.`);

    // 2. Check raw_jobs table descriptions
    console.log("\nChecking descriptions in 'raw_jobs' table...");
    const rawJobsRes = await pool.query("SELECT id, company_name, title, raw_description FROM raw_jobs");
    console.log(`Found ${rawJobsRes.rows.length} total records in 'raw_jobs' table.`);

    let rawJobsFixed = 0;
    for (const row of rawJobsRes.rows) {
      let desc = row.raw_description;
      let needsFix = false;
      let parsed: any = null;

      if (!desc) {
        needsFix = true;
        parsed = {
          job_description: "No description available.",
          key_responsibilities: [],
          technical_skills: [],
          qualifications_education: [],
          nice_to_haves: []
        };
      } else if (typeof desc === 'string') {
        let trimmed = desc.trim();
        if (trimmed.startsWith('{')) {
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            needsFix = true;
            parsed = {
              job_description: desc,
              key_responsibilities: [],
              technical_skills: [],
              qualifications_education: [],
              nice_to_haves: []
            };
          }
        } else {
          needsFix = true;
          parsed = {
            job_description: desc,
            key_responsibilities: [],
            technical_skills: [],
            qualifications_education: [],
            nice_to_haves: []
          };
        }
      } else if (typeof desc === 'object') {
        parsed = desc;
        // Make sure all required fields are present
        if (
          !('job_description' in parsed) ||
          !('key_responsibilities' in parsed) ||
          !('technical_skills' in parsed) ||
          !('qualifications_education' in parsed) ||
          !('nice_to_haves' in parsed)
        ) {
          needsFix = true;
          parsed = {
            job_description: parsed.job_description || "No description available.",
            key_responsibilities: parsed.key_responsibilities || [],
            technical_skills: parsed.technical_skills || [],
            qualifications_education: parsed.qualifications_education || [],
            nice_to_haves: parsed.nice_to_haves || []
          };
        }
      }

      if (needsFix && parsed) {
        await pool.query(
          "UPDATE raw_jobs SET raw_description = $1 WHERE id = $2",
          [JSON.stringify(parsed), row.id]
        );
        rawJobsFixed++;
      }
    }
    console.log(`✅ Finished checking 'raw_jobs' table. Fixed/standardized: ${rawJobsFixed} rows.`);

    // 3. Deduplicate 'jobs' table
    console.log("\nDeduplicating 'jobs' table...");
    const dupJobsCount = await pool.query(`
      WITH dups AS (
        SELECT id, ROW_NUMBER() OVER(PARTITION BY company_name, title ORDER BY id) as rn
        FROM jobs
      )
      DELETE FROM jobs WHERE id IN (SELECT id FROM dups WHERE rn > 1)
    `);
    console.log(`✅ Duplicate jobs cleaned up. Rows affected: ${dupJobsCount.rowCount}`);

    // 4. Deduplicate 'raw_jobs' table
    console.log("Deduplicating 'raw_jobs' table...");
    const dupRawJobsCount = await pool.query(`
      WITH dups AS (
        SELECT id, ROW_NUMBER() OVER(PARTITION BY company_name, title ORDER BY id) as rn
        FROM raw_jobs
      )
      DELETE FROM raw_jobs WHERE id IN (SELECT id FROM dups WHERE rn > 1)
    `);
    console.log(`✅ Duplicate raw_jobs cleaned up. Rows affected: ${dupRawJobsCount.rowCount}`);

  } catch (err: any) {
    console.error("❌ Fatal validation error:", err.message || err);
  } finally {
    await pool.end();
    console.log("\n====================================================");
    console.log("           DATABASE INTEGRITY RUN COMPLETED          ");
    console.log("====================================================");
  }
}

run();
