import pg from "pg";
import dotenv from "dotenv";
import { pgSslConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL),
});

async function runIntegrityChecks() {
  console.log("Running Data Integrity Checks...");
  let errors = 0;

  try {
    const ctx = await resolveWorkspaceContext(pool as any);

    // Check 1: Orphaned job versions
    const { rows: orphans } = await pool.query(`
      SELECT jv.id
      FROM job_versions jv
      LEFT JOIN canonical_jobs c
        ON c.id = jv.canonical_job_id
       AND c.workspace_id = jv.workspace_id
      WHERE jv.workspace_id = $1
        AND c.id IS NULL
    `, [ctx.workspaceId]);
    if (orphans.length > 0) {
      console.error(`Found ${orphans.length} orphaned job version(s).`);
      errors++;
    } else {
      console.log("OK: No orphaned job versions found.");
    }

    // Check 2: Canonical jobs without versions
    const { rows: missingVersions } = await pool.query(`
      SELECT c.id
      FROM canonical_jobs c
      LEFT JOIN job_versions jv
        ON jv.canonical_job_id = c.id
       AND jv.workspace_id = c.workspace_id
      WHERE c.workspace_id = $1
        AND jv.id IS NULL
    `, [ctx.workspaceId]);
    if (missingVersions.length > 0) {
      console.error(`Found ${missingVersions.length} canonical job(s) without a version.`);
      errors++;
    } else {
      console.log("OK: All canonical jobs have at least one version.");
    }

    // Check 3: Invalid lifecycle states (processing_state preferred; falls back to legacy processing_status)
    const validStates = [
      "RAW_STAGED",
      "HARD_REJECTED",
      "NEEDS_VERIFICATION",
      "PREQUALIFIED",
      "ROUTING_DEFERRED",
      "LANE_ROUTED",
      "MATCHED",
      "QUEUED_FOR_AI",
      "EVALUATING",
      "AI_EVALUATED",
      "RETRY_WAIT",
      "NEEDS_MANUAL_REVIEW",
      "MANUALLY_REMOVED",
    ];

    const { rows: invalidState } = await pool.query(
      `
      SELECT id, COALESCE(processing_state, processing_status) AS processing_state
      FROM canonical_jobs
      WHERE workspace_id = $2
        AND COALESCE(processing_state, processing_status) != ALL($1::varchar[])
    `,
      [validStates, ctx.workspaceId]
    );
    if (invalidState.length > 0) {
      console.error(`Found ${invalidState.length} job(s) with invalid processing_state.`);
      errors++;
    } else {
      console.log("OK: All canonical jobs have valid processing_state.");
    }

    // Check 4: Missing required fields
    const { rows: missingFields } = await pool.query(`
      SELECT id
      FROM canonical_jobs
      WHERE workspace_id = $1
        AND (company_name IS NULL OR normalized_title IS NULL)
    `, [ctx.workspaceId]);
    if (missingFields.length > 0) {
      console.error(`Found ${missingFields.length} job(s) with missing company name or title.`);
      errors++;
    } else {
      console.log("OK: All canonical jobs have required fields.");
    }

    // Check 5: Evaluation queue without canonical job
    const { rows: invalidQueue } = await pool.query(`
      SELECT eq.id
      FROM evaluation_queue eq
      LEFT JOIN canonical_jobs c
        ON c.id = eq.canonical_job_id
       AND c.workspace_id = eq.workspace_id
      WHERE eq.workspace_id = $1
        AND c.id IS NULL
    `, [ctx.workspaceId]);
    if (invalidQueue.length > 0) {
      console.error(`Found ${invalidQueue.length} evaluation queue item(s) without a canonical job.`);
      errors++;
    } else {
      console.log("OK: All evaluation queue items are linked to a canonical job.");
    }

    if (errors === 0) {
      console.log("All integrity checks passed.");
    } else {
      console.log(`Finished with ${errors} integrity check failure(s).`);
    }
  } catch (err: any) {
    console.error("Failed to run integrity checks", err?.message || err);
    errors++;
  } finally {
    await pool.end();
    process.exit(errors === 0 ? 0 : 1);
  }
}

runIntegrityChecks();
