import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import { runHardGates } from "../src/pipeline/hardGate.js";
import { runLaneRouting } from "../src/pipeline/laneRouter.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

interface ReplayResult {
  candidateCount: number;
  passedCount: number;
  stillRejectedCount: number;
  newlyRoutedLanes: Record<string, number>;
}

export async function replayJuniorRoles(options?: { apply?: boolean; limit?: number }): Promise<ReplayResult> {
  const apply = options?.apply ?? process.argv.includes("--apply");
  const limit = options?.limit ?? 100;
  const databaseUrl = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  console.log("====================================================");
  console.log(` REPLAY GATE_EXPERIENCE_TOO_LOW JOBS                 ${apply ? "[APPLY]" : "[DRY RUN]"}`);
  console.log("====================================================");

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const ctx = await resolveWorkspaceContext(pool as any);

  // Find non-fixture jobs whose sole latest rejection code is GATE_EXPERIENCE_TOO_LOW
  const query = `
    WITH latest_gates AS (
      SELECT DISTINCT ON (canonical_job_id)
        canonical_job_id,
        job_version_id,
        rejection_codes,
        created_at
      FROM gate_decisions
      WHERE workspace_id = $1
      ORDER BY canonical_job_id, created_at DESC, id DESC
    )
    SELECT
      c.id AS canonical_job_id,
      c.latest_job_version_id AS job_version_id,
      c.normalized_title,
      c.company_name,
      lg.rejection_codes
    FROM canonical_jobs c
    JOIN latest_gates lg ON lg.canonical_job_id = c.id
    WHERE c.workspace_id = $1
      AND NOT c.is_test_fixture
      AND lg.rejection_codes = '["GATE_EXPERIENCE_TOO_LOW"]'::jsonb
    ORDER BY c.created_at ASC
    LIMIT $2
  `;

  const { rows: candidates } = await pool.query(query, [ctx.workspaceId, limit]);
  console.log(`Found ${candidates.length} candidates rejected solely on GATE_EXPERIENCE_TOO_LOW.`);

  if (candidates.length === 0 || !apply) {
    for (const c of candidates) {
      console.log(`  * ${c.company_name} - ${c.normalized_title}`);
    }
    await pool.end();
    return {
      candidateCount: candidates.length,
      passedCount: 0,
      stillRejectedCount: candidates.length,
      newlyRoutedLanes: {},
    };
  }

  const candidateIds = candidates.map((c) => c.canonical_job_id);
  console.log(`Re-evaluating hard gates for ${candidateIds.length} candidate jobs...`);

  await runHardGates(pool, {
    context: ctx,
    canonicalJobIds: candidateIds,
    reprocess: true,
  });

  const postGateQuery = `
    SELECT
      id,
      COALESCE(processing_state, processing_status) AS processing_state,
      gate_decision,
      gate_evidence_quotes
    FROM canonical_jobs
    WHERE workspace_id = $1 AND id = ANY($2::uuid[])
  `;
  const { rows: postGate } = await pool.query(postGateQuery, [ctx.workspaceId, candidateIds]);

  const passed = postGate.filter(
    (r) => r.gate_decision === "PASS" || r.processing_state === "PREQUALIFIED" || r.processing_state === "GATE_PASSED"
  );
  const stillRejected = postGate.filter(
    (r) => r.gate_decision !== "PASS" && r.processing_state !== "PREQUALIFIED" && r.processing_state !== "GATE_PASSED"
  );

  console.log(`\nRe-evaluation results:`);
  console.log(`- Newly passed:    ${passed.length}`);
  console.log(`- Still rejected:  ${stillRejected.length}`);

  const newlyRoutedLanes: Record<string, number> = {};
  if (passed.length > 0) {
    const passedIds = passed.map((p) => p.id);
    console.log(`Routing ${passedIds.length} newly passed jobs into lanes...`);
    await runLaneRouting(pool, {
      context: ctx,
      canonicalJobIds: passedIds,
      limit: passedIds.length,
    });

    const routingQuery = `
      SELECT primary_lane, routing_disposition, count(*) as cnt
      FROM canonical_jobs
      WHERE workspace_id = $1 AND id = ANY($2::uuid[])
      GROUP BY primary_lane, routing_disposition
    `;
    const { rows: dist } = await pool.query(routingQuery, [ctx.workspaceId, passedIds]);
    for (const d of dist) {
      const key = `${d.primary_lane || "NONE"} (${d.routing_disposition || "NONE"})`;
      newlyRoutedLanes[key] = Number(d.cnt);
      console.log(`  * ${key}: ${d.cnt}`);
    }
  }

  await pool.end();
  return {
    candidateCount: candidates.length,
    passedCount: passed.length,
    stillRejectedCount: stillRejected.length,
    newlyRoutedLanes,
  };
}

if (process.argv[1] && process.argv[1].includes("replay_junior_roles")) {
  replayJuniorRoles().catch((err) => {
    console.error("Replay junior roles failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
