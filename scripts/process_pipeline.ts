import { runNormalization } from "../src/pipeline/normalize.js";
import { runHardGates } from "../src/pipeline/hardGate.js";
import { runLaneRouting } from "../src/pipeline/laneRouter.js";
import { runEvaluationBudgeter } from "../src/pipeline/evaluationBudgeter.js";
import pg from "pg";
import dotenv from "dotenv";
import { pgSslConfig } from "../src/db/pgSsl.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL)
});

const LOCK_ID = 1001; // Global lock ID for pipeline processing

export async function processPipeline(): Promise<void> {
  console.log("====================================================");
  console.log("         STAGE 0: DISCOVERY (PROCESS PIPELINE)      ");
  console.log("====================================================");

  const client = await pool.connect();
  let lockAcquired = false;
  let pipelineError: Error | null = null;

  try {
    // Attempt to acquire an exclusive session-level advisory lock
    const { rows } = await client.query(`SELECT pg_try_advisory_lock($1) as locked`, [LOCK_ID]);
    lockAcquired = Boolean(rows[0]?.locked);

    if (!lockAcquired) {
      console.warn("⚠️ Another instance of the pipeline is currently running. Exiting cleanly.");
      return;
    }
    
    console.log("\n[1/4] Running Normalization...");
    const normSummary = await runNormalization(pool);

    console.log("\n[2/4] Running Hard Gates...");
    const gateSummary = await runHardGates(pool);

    console.log("\n[3/4] Running Semantic Lane Routing...");
    const routingSummary = await runLaneRouting(pool);

    console.log("\n[4/4] Running Evaluation Budgeter...");
    const budgetSummary = await runEvaluationBudgeter(pool);

    // ── Funnel Conservation & Stranded Record Verification ──
    console.log("\n--- Verifying Funnel Conservation ---");
    const { rows: statusCounts } = await pool.query(`
      SELECT processing_status, COUNT(*)::int as count
      FROM canonical_jobs
      GROUP BY processing_status
    `);

    const counts: Record<string, number> = {};
    for (const r of statusCounts) {
      counts[r.processing_status] = r.count;
    }

    console.log("Current Canonical Jobs Status Distribution:", counts);

    // Check for stranded intermediate states
    const strandedRawStaged = counts["RAW_STAGED"] || 0;
    const strandedPrequalified = counts["PREQUALIFIED"] || 0;
    const strandedLaneRouted = counts["LANE_ROUTED"] || 0;

    if (strandedRawStaged > 0 || strandedPrequalified > 0 || strandedLaneRouted > 0) {
      const errorMsg = `❌ Funnel conservation failure: Found stranded records in intermediate states! (RAW_STAGED: ${strandedRawStaged}, PREQUALIFIED: ${strandedPrequalified}, LANE_ROUTED: ${strandedLaneRouted})`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    if (normSummary.totalErrors > 0) {
      throw new Error(`Normalization failed for ${normSummary.totalErrors} observation(s); records remain pending for retry.`);
    }

    console.log("\n✅ Pipeline execution and funnel conservation verified successfully.");
  } catch (err: any) {
    pipelineError = err;
    console.error("❌ Pipeline execution failed:", err.message || err);
  } finally {
    if (lockAcquired) {
      await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_ID]).catch(() => {});
    }
    client.release();
    await pool.end();
  }

  if (pipelineError) {
    process.exitCode = 1;
    throw pipelineError;
  }
}

if (process.argv[1] && process.argv[1].includes("process_pipeline")) {
  processPipeline().catch(() => {
    process.exit(1);
  });
}
