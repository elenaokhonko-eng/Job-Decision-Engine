/**
 * Script: Requeue Manual-Review Evaluations (Audited)
 *
 * Scans for jobs in NEEDS_MANUAL_REVIEW caused by culture quote errors,
 * logs an audit trail, and safely returns them to the evaluation queue.
 *
 * Invariant: Thresholds are never lowered.
 *
 * Usage:
 *   npx tsx scripts/requeue_manual_review_evaluations.ts          # Dry-run
 *   npx tsx scripts/requeue_manual_review_evaluations.ts --apply  # Requeue
 */

import dotenv from "dotenv";
import pg from "pg";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import { requeueManualReviewEvaluations } from "../src/pipeline/requeueManualReview.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");

  console.log("====================================================");
  console.log("   AUDITED REQUEUE: MANUAL-REVIEW EVALUATIONS       ");
  console.log(`   Mode: ${apply ? "APPLY (Transactional Execution)" : "DRY-RUN (Inspection Only)"}`);
  console.log("   Invariant: Thresholds were NOT lowered.          ");
  console.log("====================================================\n");

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }

  const pool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));
  const client = await pool.connect();

  try {
    const ctx = await resolveWorkspaceContext(client as any);

    await client.query("BEGIN");
    const result = await requeueManualReviewEvaluations(client, ctx.workspaceId, {
      dryRun: !apply,
    });

    if (apply) {
      await client.query("COMMIT");
      console.log(`✓ Audited requeue committed. Requeued ${result.requeuedCount} jobs.`);
    } else {
      await client.query("ROLLBACK");
      console.log(`ℹ Dry-run completed. Found ${result.candidatesFound} candidate(s) for requeuing.`);
    }

    console.log("\nAudit Details:");
    console.log(JSON.stringify(result, null, 2));

    if (!apply && result.candidatesFound > 0) {
      console.log("\nTo execute the requeue, run with --apply:");
      console.log("  npx tsx scripts/requeue_manual_review_evaluations.ts --apply");
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Requeue script failed:", err);
  process.exit(1);
});
