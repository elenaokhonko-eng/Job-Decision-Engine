import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import { runLaneRouting } from "../src/pipeline/laneRouter.js";
import { runDeterministicMatcher } from "../src/pipeline/deterministicMatcher.js";
import { runRecommendationDecider } from "../src/pipeline/recommendationDecider.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

async function run() {
  const pool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL_UNPOOLED));
  const ctx = await resolveWorkspaceContext(pool as any);

  const { rows } = await pool.query(`
    SELECT id
    FROM canonical_jobs
    WHERE workspace_id = $1
      AND NOT is_test_fixture
      AND gate_decision = 'PASS'
    ORDER BY created_at ASC
  `, [ctx.workspaceId]);

  const ids = rows.map((r) => r.id);
  const routingStartedAt = new Date();
  console.log(`Rerouting all ${ids.length} current gate-pass jobs using active lane revisions...`);
  const routing = await runLaneRouting(pool, {
    context: ctx,
    canonicalJobIds: ids,
    limit: ids.length,
    reprocessExisting: true,
  });
  console.log("Routing summary:", routing);

  // Only advance jobs for which this replay actually created a new lane decision.
  // This keeps a second reconciliation pass idempotent and avoids duplicate match/decision artifacts.
  const routed = await pool.query(`
    SELECT DISTINCT c.id
    FROM canonical_jobs c
    JOIN lane_decisions ld ON ld.id = c.latest_lane_decision_id
    WHERE c.workspace_id = $1
      AND c.id = ANY($2::uuid[])
      AND ld.created_at >= $3
      AND c.routing_disposition = 'ROUTED'
      AND c.primary_lane IS NOT NULL AND c.primary_lane <> 'UNCLASSIFIED'
  `, [ctx.workspaceId, ids, routingStartedAt]);
  const routedIds = routed.rows.map((r) => r.id);
  if (routedIds.length > 0) {
    console.log(`Matching ${routedIds.length} newly rerouted jobs...`);
    const matching = await runDeterministicMatcher(pool, { context: ctx, canonicalJobIds: routedIds });
    console.log("Matching summary:", matching);
    const recommendations = await runRecommendationDecider(pool, { context: ctx, canonicalJobIds: routedIds });
    console.log("Recommendation summary:", recommendations);
  } else {
    console.log("No new lane decisions; skipping matching and recommendation stages for idempotency.");
  }
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
