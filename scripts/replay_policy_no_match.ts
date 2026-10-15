import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import { runLaneRouting } from "../src/pipeline/laneRouter.js";
import { runDeterministicMatcher } from "../src/pipeline/deterministicMatcher.js";
import { runRecommendationDecider } from "../src/pipeline/recommendationDecider.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

export interface PolicyNoMatchReplayResult {
  candidateCount: number;
  routedCount: number;
  unmatchedCount: number;
  newlyRoutedByLane: Record<string, number>;
  matchedCount: number;
  recommendations: Record<string, number>;
}

export async function replayPolicyNoMatch(options?: { apply?: boolean; limit?: number }): Promise<PolicyNoMatchReplayResult> {
  const apply = options?.apply ?? process.argv.includes("--apply");
  const limit = options?.limit ?? 1500;
  const databaseUrl = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  console.log("====================================================");
  console.log(` REPLAY POLICY_NO_MATCH AFTER LANE REPUBLISH         ${apply ? "[APPLY]" : "[DRY RUN]"}`);
  console.log("====================================================");

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const ctx = await resolveWorkspaceContext(pool as any);

  // Find non-fixture jobs that passed gates and currently sit in UNMATCHED / POLICY_NO_MATCH
  const query = `
    SELECT c.id AS canonical_job_id, c.latest_job_version_id AS job_version_id, c.normalized_title, c.company_name
    FROM canonical_jobs c
    WHERE c.workspace_id = $1
      AND NOT c.is_test_fixture
      AND c.gate_decision = 'PASS'
      AND (
        COALESCE(c.processing_state, c.processing_status) = 'UNMATCHED'
        OR c.routing_disposition = 'POLICY_NO_MATCH'
      )
    ORDER BY c.created_at ASC
    LIMIT $2
  `;

  const { rows: candidates } = await pool.query(query, [ctx.workspaceId, limit]);
  console.log(`Found ${candidates.length} candidates in UNMATCHED / POLICY_NO_MATCH.`);

  if (candidates.length === 0 || !apply) {
    await pool.end();
    return {
      candidateCount: candidates.length,
      routedCount: 0,
      unmatchedCount: candidates.length,
      newlyRoutedByLane: {},
      matchedCount: 0,
      recommendations: {},
    };
  }

  const candidateIds = candidates.map((c) => c.canonical_job_id);
  console.log(`Routing ${candidateIds.length} candidate jobs using newly active lane definitions...`);

  await runLaneRouting(pool, {
    context: ctx,
    canonicalJobIds: candidateIds,
    limit: candidateIds.length,
  });

  const postRoutingQuery = `
    SELECT id, primary_lane, routing_disposition, COALESCE(processing_state, processing_status) as state
    FROM canonical_jobs
    WHERE workspace_id = $1 AND id = ANY($2::uuid[])
  `;
  const { rows: postRouting } = await pool.query(postRoutingQuery, [ctx.workspaceId, candidateIds]);

  const routedJobs = postRouting.filter((r) => r.routing_disposition === "ROUTED" && r.primary_lane && r.primary_lane !== "UNCLASSIFIED");
  const unmatchedJobs = postRouting.filter((r) => r.routing_disposition !== "ROUTED" || !r.primary_lane || r.primary_lane === "UNCLASSIFIED");

  const newlyRoutedByLane: Record<string, number> = {};
  for (const j of routedJobs) {
    const lane = j.primary_lane || "UNKNOWN";
    newlyRoutedByLane[lane] = (newlyRoutedByLane[lane] || 0) + 1;
  }

  console.log(`\nLane Routing Results:`);
  console.log(`- Newly Routed into Active Lanes: ${routedJobs.length}`);
  console.log(`- Remained Unmatched:            ${unmatchedJobs.length}`);
  for (const [lane, cnt] of Object.entries(newlyRoutedByLane)) {
    console.log(`  * ${lane}: ${cnt}`);
  }

  let matchedCount = 0;
  const recommendations: Record<string, number> = {};

  if (routedJobs.length > 0) {
    const routedIds = routedJobs.map((r) => r.id);
    console.log(`\nRunning deterministic matching for ${routedIds.length} newly routed jobs...`);
    const matchRes = await runDeterministicMatcher(pool, {
      context: ctx,
      canonicalJobIds: routedIds,
    });
    matchedCount = matchRes.matchedJobs;
    console.log(`Matcher result: ${JSON.stringify(matchRes)}`);

    console.log(`Running recommendation decider...`);
    const recRes = await runRecommendationDecider(pool, {
      context: ctx,
      canonicalJobIds: routedIds,
    });
    console.log(`Decision result: ${JSON.stringify(recRes)}`);

    const recQuery = `
      SELECT recommendation_outcome, count(*) as cnt
      FROM canonical_jobs
      WHERE workspace_id = $1 AND id = ANY($2::uuid[])
      GROUP BY recommendation_outcome
    `;
    const { rows: recRows } = await pool.query(recQuery, [ctx.workspaceId, routedIds]);
    for (const r of recRows) {
      recommendations[r.recommendation_outcome || "NONE"] = Number(r.cnt);
      console.log(`  * Outcome ${r.recommendation_outcome}: ${r.cnt}`);
    }
  }

  await pool.end();
  return {
    candidateCount: candidates.length,
    routedCount: routedJobs.length,
    unmatchedCount: unmatchedJobs.length,
    newlyRoutedByLane,
    matchedCount,
    recommendations,
  };
}

if (process.argv[1] && process.argv[1].includes("replay_policy_no_match")) {
  replayPolicyNoMatch().catch((err) => {
    console.error("Replay policy no match failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
