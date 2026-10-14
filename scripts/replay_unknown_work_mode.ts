import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import { enrichWorkModeIfNeeded } from "../src/services/workModeEnrichment.js";
import { runHardGates } from "../src/pipeline/hardGate.js";
import { runLaneRouting } from "../src/pipeline/laneRouter.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

interface ReplayOptions {
  apply: boolean;
  limit: number;
}

function parseArgs(argv: readonly string[]): ReplayOptions {
  const limitIndex = argv.indexOf("--limit");
  const parsedLimit = limitIndex >= 0 && argv[limitIndex + 1] ? Number.parseInt(argv[limitIndex + 1], 10) : 1000;
  return {
    apply: argv.includes("--apply"),
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 1000,
  };
}

export async function replayUnknownWorkMode(options?: Partial<ReplayOptions>): Promise<{
  candidateCount: number;
  enrichedCount: number;
  passedCount: number;
  stillRejectedCount: number;
  newlyRoutedLanes: Record<string, number>;
}> {
  const parsed = options ? { apply: options.apply ?? false, limit: options.limit ?? 1000 } : parseArgs(process.argv.slice(2));
  const databaseUrl = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  console.log("====================================================");
  console.log(` REPLAY UNKNOWN WORK MODE ENRICHMENT & GATES        ${parsed.apply ? "[APPLY]" : "[DRY RUN]"}`);
  console.log("====================================================");

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));

  try {
    const ctx = await resolveWorkspaceContext(pool as any);

    // Find non-fixture jobs whose latest gate decision rejected on GATE_UNKNOWN_WORK_MODE
    const candidatesQuery = `
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
        c.location,
        c.workplace_type,
        c.canonical_url,
        jv.description_text,
        lg.rejection_codes
      FROM canonical_jobs c
      JOIN latest_gates lg ON lg.canonical_job_id = c.id
      JOIN job_versions jv ON jv.id = c.latest_job_version_id
      WHERE c.workspace_id = $1
        AND c.is_test_fixture = FALSE
        AND lg.rejection_codes ? 'GATE_UNKNOWN_WORK_MODE'
      ORDER BY c.created_at ASC, c.id ASC
      LIMIT $2
    `;

    const { rows: candidates } = await pool.query(candidatesQuery, [ctx.workspaceId, parsed.limit]);
    console.log(`Found ${candidates.length} candidates with GATE_UNKNOWN_WORK_MODE.`);

    if (candidates.length === 0) {
      return { candidateCount: 0, enrichedCount: 0, passedCount: 0, stillRejectedCount: 0, newlyRoutedLanes: {} };
    }

    if (!parsed.apply) {
      console.log(`Dry run complete. Found ${candidates.length} candidate jobs to enrich and replay.`);
      console.log("Re-run with --apply to execute the enrichment and gate replay.");
      return {
        candidateCount: candidates.length,
        enrichedCount: 0,
        passedCount: 0,
        stillRejectedCount: candidates.length,
        newlyRoutedLanes: {},
      };
    }

    let enrichedCount = 0;
    console.log(`Enriching work mode evidence across ${candidates.length} candidates...`);

    for (const job of candidates) {
      const enrichment = await enrichWorkModeIfNeeded(pool, ctx, {
        canonical_job_id: job.canonical_job_id,
        job_version_id: job.job_version_id,
        workplace_type: job.workplace_type,
        description_text: job.description_text,
        canonical_url: job.canonical_url,
      });

      if (enrichment && enrichment.workplace_type !== "UNKNOWN") {
        enrichedCount += 1;
      }
    }
    console.log(`Successfully enriched ${enrichedCount}/${candidates.length} jobs with concrete work mode.`);

    const candidateIds = candidates.map((c) => c.canonical_job_id);

    console.log(`Re-evaluating hard gates for ${candidateIds.length} candidate jobs...`);
    await runHardGates(pool, {
      context: ctx,
      canonicalJobIds: candidateIds,
      reprocess: true,
    });

    // Check newly updated gate status
    const postGateQuery = `
      SELECT
        id,
        COALESCE(processing_state, processing_status) AS processing_state,
        gate_decision,
        workplace_type,
        gate_evidence_quotes
      FROM canonical_jobs
      WHERE workspace_id = $1
        AND id = ANY($2::uuid[])
    `;
    const { rows: postGateRows } = await pool.query(postGateQuery, [ctx.workspaceId, candidateIds]);

    const passedJobs = postGateRows.filter(
      (r) => r.gate_decision === "PASS" || r.processing_state === "PREQUALIFIED" || r.processing_state === "GATE_PASSED"
    );
    const stillRejected = postGateRows.filter(
      (r) => r.gate_decision !== "PASS" && r.processing_state !== "PREQUALIFIED" && r.processing_state !== "GATE_PASSED"
    );

    console.log(`\nGate re-evaluation results:`);
    console.log(`- Newly passed hard gates: ${passedJobs.length}`);
    console.log(`- Still rejected:          ${stillRejected.length}`);

    const newlyRoutedLanes: Record<string, number> = {};

    if (passedJobs.length > 0) {
      const passedIds = passedJobs.map((j) => j.id);
      console.log(`\nRouting ${passedIds.length} newly passed jobs into active lanes...`);
      await runLaneRouting(pool, {
        context: ctx,
        canonicalJobIds: passedIds,
        limit: passedIds.length,
      });

      const postRoutingQuery = `
        SELECT
          primary_lane,
          routing_disposition,
          COUNT(*) as cnt
        FROM canonical_jobs
        WHERE workspace_id = $1
          AND id = ANY($2::uuid[])
        GROUP BY primary_lane, routing_disposition
      `;
      const { rows: routingDist } = await pool.query(postRoutingQuery, [ctx.workspaceId, passedIds]);
      console.log(`\nLane routing distribution for unblocked jobs:`);
      for (const row of routingDist) {
        const key = `${row.primary_lane || "NONE"} (${row.routing_disposition || "NONE"})`;
        newlyRoutedLanes[key] = Number(row.cnt);
        console.log(`- ${key}: ${row.cnt}`);
      }
    }

    return {
      candidateCount: candidates.length,
      enrichedCount,
      passedCount: passedJobs.length,
      stillRejectedCount: stillRejected.length,
      newlyRoutedLanes,
    };
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].includes("replay_unknown_work_mode")) {
  replayUnknownWorkMode().catch((err) => {
    console.error("Replay failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
