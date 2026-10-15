import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import { enqueuePipelineTask } from "../src/tasks/pipelineTasks.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

export interface StateReconcileResult {
  enqueuedRouteLane: number;
  reconciledToLaneRouted: number;
  reconciledToUnmatched: number;
  reconciledToMatched: number;
  alreadyCompleted: number;
  totalUpdated: number;
}

export async function reconcileStrandedStates(options?: {
  clientOrPool?: pg.Pool | pg.PoolClient;
  apply?: boolean;
}): Promise<StateReconcileResult> {
  const apply = options?.apply ?? process.argv.includes("--apply");
  const databaseUrl = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim();
  if (!databaseUrl && !options?.clientOrPool) throw new Error("DATABASE_URL is required.");

  const pool = options?.clientOrPool || new pg.Pool(pgPoolConfig(databaseUrl));
  const isOwnPool = !options?.clientOrPool;

  const result: StateReconcileResult = {
    enqueuedRouteLane: 0,
    reconciledToLaneRouted: 0,
    reconciledToUnmatched: 0,
    reconciledToMatched: 0,
    alreadyCompleted: 0,
    totalUpdated: 0,
  };

  try {
    const ctx = await resolveWorkspaceContext(pool as any);

    // Rule 2: PREQUALIFIED + routing_disposition=ROUTED -> reconcile to LANE_ROUTED
    const r2Query = `
      SELECT c.id, c.latest_job_version_id, c.primary_lane
      FROM canonical_jobs c
      WHERE c.workspace_id = $1
        AND NOT c.is_test_fixture
        AND COALESCE(c.processing_state, c.processing_status) IN ('PREQUALIFIED', 'UNMATCHED', 'ROUTING_DEFERRED')
        AND c.routing_disposition = 'ROUTED'
        AND c.primary_lane IS NOT NULL
        AND c.primary_lane <> 'UNCLASSIFIED'
    `;
    const r2 = await pool.query(r2Query, [ctx.workspaceId]);
    result.reconciledToLaneRouted = r2.rows.length;
    if (apply && r2.rows.length > 0) {
      const ids = r2.rows.map((r) => r.id);
      await pool.query(
        `UPDATE canonical_jobs
         SET processing_state = 'LANE_ROUTED',
             processing_status = 'LANE_ROUTED',
             updated_at = NOW()
         WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
        [ctx.workspaceId, ids]
      );
    }

    // Rule 3: PREQUALIFIED + routing_disposition=POLICY_NO_MATCH -> UNMATCHED
    const r3Query = `
      SELECT c.id
      FROM canonical_jobs c
      WHERE c.workspace_id = $1
        AND NOT c.is_test_fixture
        AND COALESCE(c.processing_state, c.processing_status) = 'PREQUALIFIED'
        AND c.routing_disposition = 'POLICY_NO_MATCH'
    `;
    const r3 = await pool.query(r3Query, [ctx.workspaceId]);
    result.reconciledToUnmatched = r3.rows.length;
    if (apply && r3.rows.length > 0) {
      const ids = r3.rows.map((r) => r.id);
      await pool.query(
        `UPDATE canonical_jobs
         SET processing_state = 'UNMATCHED',
             processing_status = 'UNMATCHED',
             rejection_reason = COALESCE(rejection_reason, 'NO_ACTIVE_LANE_MATCH'),
             updated_at = NOW()
         WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
        [ctx.workspaceId, ids]
      );
    }

    // Rule 4: LANE_ROUTED + complete match artifact -> reconcile to MATCHED
    const r4Query = `
      SELECT c.id
      FROM canonical_jobs c
      JOIN match_runs mr ON mr.id = c.latest_match_run_id AND mr.canonical_job_id = c.id
      WHERE c.workspace_id = $1
        AND NOT c.is_test_fixture
        AND COALESCE(c.processing_state, c.processing_status) = 'LANE_ROUTED'
        AND mr.status = 'COMPLETED'
        AND c.profile_match_status = 'POSITIVE_MATCH'
    `;
    const r4 = await pool.query(r4Query, [ctx.workspaceId]);
    result.reconciledToMatched = r4.rows.length;
    if (apply && r4.rows.length > 0) {
      const ids = r4.rows.map((r) => r.id);
      await pool.query(
        `UPDATE canonical_jobs
         SET processing_state = 'MATCHED',
             processing_status = 'MATCHED',
             updated_at = NOW()
         WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
        [ctx.workspaceId, ids]
      );
    }

    // Rule 5: MATCHED + current recommendation decision -> terminal completed state
    const r5Query = `
      SELECT c.id, c.recommendation_outcome
      FROM canonical_jobs c
      WHERE c.workspace_id = $1
        AND NOT c.is_test_fixture
        AND COALESCE(c.processing_state, c.processing_status) = 'MATCHED'
        AND c.recommendation_outcome IS NOT NULL
    `;
    const r5 = await pool.query(r5Query, [ctx.workspaceId]);
    result.alreadyCompleted = r5.rows.length;

    // Rule 1: PASS + no routing artifact + no active task -> enqueue ROUTE_LANE
    const r1Query = `
      SELECT c.id, c.latest_job_version_id
      FROM canonical_jobs c
      WHERE c.workspace_id = $1
        AND NOT c.is_test_fixture
        AND c.gate_decision = 'PASS'
        AND COALESCE(c.processing_state, c.processing_status) = 'PREQUALIFIED'
        AND c.routing_disposition IS NULL
        AND c.primary_lane IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM pipeline_tasks pt
          WHERE pt.workspace_id = c.workspace_id
            AND pt.task_type = 'ROUTE_LANE'
            AND pt.payload->>'canonical_job_id' = c.id::text
            AND pt.status IN ('PENDING', 'RUNNING')
        )
      LIMIT 200
    `;
    const r1 = await pool.query(r1Query, [ctx.workspaceId]);
    result.enqueuedRouteLane = r1.rows.length;
    if (apply && r1.rows.length > 0) {
      for (const row of r1.rows) {
        if (row.latest_job_version_id) {
          await enqueuePipelineTask(
            {
              taskType: "ROUTE_LANE",
              taskKey: `ROUTE_LANE:${row.latest_job_version_id}`,
              payload: {
                canonical_job_id: row.id,
                job_version_id: row.latest_job_version_id,
              },
            },
            pool,
            { context: ctx }
          ).catch(() => undefined);
        }
      }
    }

    result.totalUpdated =
      result.reconciledToLaneRouted +
      result.reconciledToUnmatched +
      result.reconciledToMatched;

    console.log("STATE RECONCILIATION SUMMARY:", result);
    return result;
  } finally {
    if (isOwnPool && typeof (pool as any).end === "function") {
      await (pool as any).end();
    }
  }
}

if (process.argv[1] && process.argv[1].includes("reconcile_states")) {
  reconcileStrandedStates({ apply: process.argv.includes("--apply") }).catch((err) => {
    console.error("State reconciliation failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
