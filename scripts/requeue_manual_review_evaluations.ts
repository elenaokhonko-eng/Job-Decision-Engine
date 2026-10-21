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
 *   npx tsx scripts/requeue_manual_review_evaluations.ts --apply --queue-id <uuid> --queue-id <uuid>
 */

import dotenv from "dotenv";
import pg from "pg";
import { isPooledPostgresConnectionString, pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import { requeueManualReviewEvaluations } from "../src/pipeline/requeueManualReview.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const queueIds = args.flatMap((argument, index) =>
    argument === "--queue-id" && args[index + 1] ? [args[index + 1]] : []
  );
  const uniqueQueueIds = [...new Set(queueIds)];

  if (apply && uniqueQueueIds.length !== 2) {
    throw new Error("--apply requires exactly two distinct --queue-id values.");
  }
  if (uniqueQueueIds.some((queueId) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(queueId))) {
    throw new Error("Every --queue-id must be a UUID.");
  }

  const databaseUrl = apply
    ? process.env.STAGE3_STAGING_DATABASE_URL
    : process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(apply
      ? "STAGE3_STAGING_DATABASE_URL is required for requeue writes."
      : "DATABASE_URL or DATABASE_URL_UNPOOLED is required for the dry-run.");
  }
  if (apply && isPooledPostgresConnectionString(databaseUrl)) {
    throw new Error("Requeue writes require a direct staging connection, not a pooled URL.");
  }

  console.log("====================================================");
  console.log("   AUDITED REQUEUE: MANUAL-REVIEW EVALUATIONS       ");
  console.log(`   Mode: ${apply ? "STAGING APPLY (Transactional Execution)" : "DRY-RUN (Inspection Only)"}`);
  console.log("   Invariant: Thresholds were NOT lowered.          ");
  console.log("====================================================\n");

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const client = await pool.connect();

  try {
    const ctx = await resolveWorkspaceContext(client as any);

    await client.query("BEGIN");
    const result = await requeueManualReviewEvaluations(client, ctx.workspaceId, {
      dryRun: !apply,
      queueIds: uniqueQueueIds,
    });

    if (apply) {
      if (result.requeuedCount !== 2) {
        throw new Error(`Expected exactly two requeued jobs; received ${result.requeuedCount}.`);
      }
      await client.query("COMMIT");
      console.log(`✓ Audited staging requeue committed. Requeued ${result.requeuedCount} jobs.`);
    } else {
      await client.query("ROLLBACK");
      console.log(`ℹ Dry-run completed. Found ${result.candidatesFound} candidate(s) for requeuing.`);
    }

    console.log("\nAudit Details:");
    console.log(JSON.stringify(result, null, 2));

    if (!apply && result.candidatesFound > 0) {
      console.log("\nTo execute the bounded staging requeue, pass exactly two queue IDs with --apply.");
    }
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Requeue rollback failed:", rollbackError instanceof Error ? rollbackError.message : rollbackError);
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Requeue script failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
