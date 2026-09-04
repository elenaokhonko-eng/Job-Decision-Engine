import { runNormalization } from "../src/pipeline/normalize.js";
import { runRequirementsExtraction } from "../src/pipeline/requirementsExtractor.js";
import { runHardGates } from "../src/pipeline/hardGate.js";
import { runLaneRouting } from "../src/pipeline/laneRouter.js";
import { runDeterministicMatcher } from "../src/pipeline/deterministicMatcher.js";
import { runRecommendationDecider } from "../src/pipeline/recommendationDecider.js";
import { runExplanationQueueEnqueuer } from "../src/pipeline/explanationQueueEnqueuer.js";
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

const LOCK_ID = 1001; // Global lock ID for pipeline processing

export async function processPipeline(): Promise<void> {
  console.log("====================================================");
  console.log("                PROCESS PIPELINE                    ");
  console.log("====================================================");

  const client = await pool.connect();
  let lockAcquired = false;
  let pipelineError: Error | null = null;

  try {
    const { rows } = await client.query(`SELECT pg_try_advisory_lock($1) as locked`, [LOCK_ID]);
    lockAcquired = Boolean(rows[0]?.locked);

    if (!lockAcquired) {
      console.warn("Another instance of the pipeline is currently running. Exiting cleanly.");
      return;
    }

    const ctx = await resolveWorkspaceContext(client as any);

    console.log("\n[1/7] Normalization...");
    const normSummary = await runNormalization(pool, { context: ctx });

    console.log("\n[2/7] Requirements Extraction...");
    const requirementsSummary = await runRequirementsExtraction(pool, { context: ctx });

    console.log("\n[3/7] Hard Gates...");
    const gateSummary = await runHardGates(pool, { context: ctx });

    console.log("\n[4/7] Semantic Lane Routing...");
    const routingSummary = await runLaneRouting(pool, { context: ctx });

    console.log("\n[5/7] Deterministic Matching...");
    const matchingSummary = await runDeterministicMatcher(pool, { context: ctx });

    console.log("\n[6/7] Deterministic Recommendation Decider...");
    const decisionSummary = await runRecommendationDecider(pool, { context: ctx });

    console.log("\n[7/7] Explanation Queue Enqueue (optional; no quota/deferral)...");
    const enqueueSummary = await runExplanationQueueEnqueuer(pool, { context: ctx });

    console.log("\n--- Verifying Funnel Conservation ---");
    const { rows: stateCounts } = await pool.query(`
      SELECT COALESCE(processing_state, processing_status) AS processing_state, COUNT(*)::int as count
      FROM canonical_jobs
      WHERE workspace_id = $1
      GROUP BY COALESCE(processing_state, processing_status)
    `, [ctx.workspaceId]);

    const counts: Record<string, number> = {};
    for (const r of stateCounts) {
      counts[r.processing_state] = r.count;
    }

    console.log("Current Canonical Jobs State Distribution:", counts);

    const strandedRawStaged = counts["RAW_STAGED"] || 0;
    const strandedPrequalified = counts["PREQUALIFIED"] || 0;
    if (strandedRawStaged > 0 || strandedPrequalified > 0) {
      throw new Error(
        `Funnel conservation failure: Found stranded records in upstream states (RAW_STAGED: ${strandedRawStaged}, PREQUALIFIED: ${strandedPrequalified})`
      );
    }

    const deferredBudget = counts["DEFERRED_BUDGET"] || 0;
    if (deferredBudget > 0) {
      throw new Error(`Funnel invariant failure: Found ${deferredBudget} record(s) in DEFERRED_BUDGET.`);
    }

    const { rows: undecidedRows } = await pool.query(`
      SELECT COUNT(*)::int AS n
      FROM canonical_jobs
      WHERE workspace_id = $1
        AND COALESCE(processing_state, processing_status) <> 'MANUALLY_REMOVED'
        AND recommendation_outcome IS NULL
    `, [ctx.workspaceId]);
    const missingDecisions = undecidedRows?.[0]?.n ?? 0;
    if (missingDecisions > 0) {
      throw new Error(
        `Funnel invariant failure: ${missingDecisions} job(s) are missing deterministic recommendation_outcome.`
      );
    }

    if (normSummary.totalErrors > 0) {
      throw new Error(
        `Normalization failed for ${normSummary.totalErrors} observation(s); records remain pending for retry.`
      );
    }

    if (requirementsSummary.errors > 0) {
      throw new Error(
        `Requirements extraction failed for ${requirementsSummary.errors} job version(s); records moved to RETRY_WAIT.`
      );
    }

    if (matchingSummary.errors > 0) {
      throw new Error(
        `Deterministic matching failed for ${matchingSummary.errors} job(s); records remain recoverable for retry.`
      );
    }

    console.log("Requirements extraction summary:", requirementsSummary);
    console.log("Hard gate summary:", gateSummary);
    console.log("Lane routing summary:", routingSummary);
    console.log("Deterministic matching summary:", matchingSummary);
    console.log("Deterministic decision summary:", decisionSummary);
    console.log("Explanation queue enqueue summary:", enqueueSummary);

    console.log("\nPipeline execution and funnel conservation verified successfully.");
  } catch (err: any) {
    pipelineError = err;
    console.error("Pipeline execution failed:", err?.message || err);
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
