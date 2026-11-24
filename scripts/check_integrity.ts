import { runZeroChecks } from "../src/tasks/integrityZeroChecks.js";
import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import { findStrandedNonterminalJobs } from "../src/ingestion/nonterminalRecovery.js";
import { awaitingVisibilityFailures, reportAwaitingContentOutputs, reportAwaitingContentVisibility } from "../src/ingestion/contentCompleteness.js";
import { reportContentWithoutFetchTask } from "../src/ingestion/fetchTaskCoverage.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

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
      "UNMATCHED",
      "PROCESSING_ERROR",
    ];

    const { rows: invalidState } = await pool.query(
      `
      SELECT id, COALESCE(processing_state, processing_status) AS processing_state
      FROM canonical_jobs
      WHERE workspace_id = $2
        AND NOT is_test_fixture
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

    // Check 6: Semantic match runs cannot complete without a compatible embedding space.
    const { rows: semanticOrphans } = await pool.query(`
      SELECT c.id
      FROM canonical_jobs c
      JOIN match_runs mr
        ON mr.workspace_id = c.workspace_id
       AND mr.id = c.latest_match_run_id
       AND mr.canonical_job_id = c.id
      WHERE c.workspace_id = $1
        AND NOT c.is_test_fixture
        AND COALESCE(c.processing_state, c.processing_status) = 'LANE_ROUTED'
        AND c.profile_match_status = 'UNKNOWN'
        AND mr.status = 'COMPLETED'
        AND mr.embedding_space_id IS NULL
    `, [ctx.workspaceId]);
    if (semanticOrphans.length > 0) {
      console.error(`Found ${semanticOrphans.length} completed semantic match orphan(s) without an embedding space.`);
      errors++;
    } else {
      console.log("OK: No completed semantic match orphans found.");
    }

    // Check 7: Automatic nonterminal jobs must have recoverable work attached (archived jobs are not live and are skipped).
    const stranded = await findStrandedNonterminalJobs(pool, ctx.workspaceId);
    if (stranded.count > 0) {
      console.error(`Found ${stranded.count} live nonterminal job(s) without active recovery tasks; first ids: ${stranded.sample.slice(0, 5).join(", ")}`);
      errors++;
    } else {
      console.log("OK: Every automatic nonterminal job has active recovery work.");
    }

    // Check 8: no list shows an awaiting-content job. Stored gate, lane and recommendation on such a job are evidence
    // and are reported as information only.
    const visibility = await reportAwaitingContentVisibility(pool, ctx.workspaceId);
    const stored = await reportAwaitingContentOutputs(pool, ctx.workspaceId);
    console.log(
      `INFO: ${stored.awaitingContentJobs} awaiting-content job(s); ${stored.violations.length} keep a stored gate decision, lane or recommendation `
      + `(hidden by the read models; first ids: ${stored.violations.slice(0, 5).map((v) => v.canonicalJobId).join(", ") || "none"}).`,
    );
    // Every expected list read model must exist and be checked (migration 120 is on main): a missing view or an empty check fails.
    const visibilityFailures = awaitingVisibilityFailures(visibility);
    if (visibilityFailures.length > 0) {
      for (const failure of visibilityFailures) console.error(`Check 8: ${failure}`);
      errors++;
    } else {
      console.log(`OK: No awaiting-content job is shown by any list read model (${visibility.viewsChecked.length} checked).`);
    }

    // Check 9: a live alert-backed job needs complete content or a fetch task; with neither it can never become complete.
    // Jobs a fetch cannot serve (feed or saved-export sources) are information only.
    const coverage = await reportContentWithoutFetchTask(pool, ctx.workspaceId);
    if (coverage.withoutFetchTask.length > 0) {
      console.error(
        `Found ${coverage.withoutFetchTask.length} live job(s) with neither complete content nor a FETCH_JOB_CONTENT task; `
        + `first ids: ${coverage.withoutFetchTask.slice(0, 5).join(", ")}`,
      );
      errors++;
    } else {
      console.log(
        `OK: Every live alert-backed job has complete content or a fetch task (${coverage.awaitingContentJobs} waiting, ${coverage.notFetchableWithoutTask} not fetchable, `
        + `${coverage.fetchDeadLetteredOnly} with only a dead-lettered fetch).`,
      );
    }

    // Checks 10 to 15: the must-be-zero set (src/tasks/integrityZeroChecks.ts).
    for (const check of await runZeroChecks(pool, ctx.workspaceId)) {
      if (check.total > 0) {
        console.error(`Found ${check.total} for ${check.name}; first ids: ${check.sample.join(", ")}`);
        errors++;
      } else {
        console.log(`OK: ${check.name} is zero.`);
      }
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
