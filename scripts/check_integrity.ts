import { db } from "../src/db/db.js";
import pg from "pg";
import dotenv from "dotenv";
import { pgSslConfig } from "../src/db/pgSsl.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL)
});

async function runIntegrityChecks() {
  console.log("Running Data Integrity Checks...");
  let errors = 0;

  try {
    // Check 1: Orphaned job versions
    const { rows: orphans } = await pool.query(`
      SELECT jv.id 
      FROM job_versions jv
      LEFT JOIN canonical_jobs c ON jv.canonical_job_id = c.id
      WHERE c.id IS NULL
    `);
    if (orphans.length > 0) {
      console.error(`❌ Found ${orphans.length} orphaned job versions.`);
      errors++;
    } else {
      console.log(`✅ No orphaned job versions found.`);
    }

    // Check 2: Canonical Jobs without versions
    const { rows: missingVersions } = await pool.query(`
      SELECT c.id 
      FROM canonical_jobs c
      LEFT JOIN job_versions jv ON c.id = jv.canonical_job_id
      WHERE jv.id IS NULL
    `);
    if (missingVersions.length > 0) {
      console.error(`❌ Found ${missingVersions.length} canonical jobs without a version.`);
      errors++;
    } else {
      console.log(`✅ All canonical jobs have at least one version.`);
    }

    // Check 3: Invalid statuses
    const validStatuses = [
      'RAW_STAGED',
      'HARD_REJECTED',
      'NEEDS_VERIFICATION',
      'PREQUALIFIED',
      'ROUTING_DEFERRED',
      'LANE_ROUTED',
      'MATCHED',
      'QUEUED_FOR_AI',
      'DEFERRED_BUDGET',
      'EVALUATING',
      'AI_EVALUATED',
      'RETRY_WAIT',
      'NEEDS_MANUAL_REVIEW',
      'MANUALLY_REMOVED'
    ];
    const { rows: invalidStatus } = await pool.query(`
      SELECT id, processing_status 
      FROM canonical_jobs 
      WHERE processing_status != ALL($1::varchar[])
    `, [validStatuses]);
    if (invalidStatus.length > 0) {
      console.error(`❌ Found ${invalidStatus.length} jobs with invalid processing status.`);
      errors++;
    } else {
      console.log(`✅ All canonical jobs have valid processing statuses.`);
    }

    // Check 4: Missing required fields
    const { rows: missingFields } = await pool.query(`
      SELECT id 
      FROM canonical_jobs 
      WHERE company_name IS NULL OR normalized_title IS NULL
    `);
    if (missingFields.length > 0) {
      console.error(`❌ Found ${missingFields.length} jobs with missing company name or title.`);
      errors++;
    } else {
      console.log(`✅ All canonical jobs have required fields.`);
    }

    // Check 5: Evaluation queue without canonical job
    const { rows: invalidQueue } = await pool.query(`
      SELECT eq.id 
      FROM evaluation_queue eq
      LEFT JOIN canonical_jobs c ON eq.canonical_job_id = c.id
      WHERE c.id IS NULL
    `);
    if (invalidQueue.length > 0) {
      console.error(`❌ Found ${invalidQueue.length} evaluation queue items without a canonical job.`);
      errors++;
    } else {
      console.log(`✅ All evaluation queue items are linked to a canonical job.`);
    }

    if (errors === 0) {
      console.log("\n🎉 All integrity checks passed!");
    } else {
      console.log(`\n⚠️ Finished with ${errors} integrity check failures.`);
    }
  } catch (err: any) {
    console.error("Failed to run integrity checks", err.message);
    errors++;
  } finally {
    await pool.end();
    process.exit(errors === 0 ? 0 : 1);
  }
}

runIntegrityChecks();
