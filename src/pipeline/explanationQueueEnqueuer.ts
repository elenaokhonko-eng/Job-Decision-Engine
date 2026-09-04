import pg from "pg";
import dotenv from "dotenv";
import { pgSslConfig } from "../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL),
});

export interface ExplanationQueueEnqueuerSummary {
  enqueued: number;
  updated: number;
}

export async function runExplanationQueueEnqueuer(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<ExplanationQueueEnqueuerSummary> {
  console.log("Starting Explanation Queue Enqueuer (unbounded eligibility)...");
  const pool = clientOrPool || defaultPool;

  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const { rows } = await client.query<{
      enqueued: number;
      updated: number;
    }>(
      `
      WITH candidates AS (
        SELECT
          c.id AS canonical_job_id,
          COALESCE(c.latest_job_version_id, lv.id) AS job_version_id,
          c.primary_lane AS lane,
          CASE
            WHEN COALESCE(c.deterministic_match_score, 0) > 0 THEN c.deterministic_match_score::float
            ELSE COALESCE(c.semantic_score, 0)::float
          END AS priority_score
        FROM canonical_jobs c
        LEFT JOIN LATERAL (
          SELECT id
          FROM job_versions
          WHERE canonical_job_id = c.id
          ORDER BY observed_at DESC
          LIMIT 1
        ) lv ON TRUE
        WHERE c.workspace_id = $1
          AND COALESCE(c.processing_state, c.processing_status) IN ('LANE_ROUTED', 'MATCHED', 'QUEUED_FOR_AI')
          AND c.primary_lane IS NOT NULL
          AND c.primary_lane <> 'UNCLASSIFIED'
          AND COALESCE(c.recommendation_eligibility, 'VERIFY') = 'ELIGIBLE'
          AND COALESCE(c.processing_state, c.processing_status) <> 'MANUALLY_REMOVED'
          AND NOT EXISTS (
            SELECT 1
            FROM ai_evaluations ae
            WHERE ae.workspace_id = $1
              AND ae.canonical_job_id = c.id
              AND ae.job_version_id = COALESCE(c.latest_job_version_id, lv.id)
          )
      ),
      inserted AS (
        INSERT INTO evaluation_queue (
          workspace_id,
          canonical_job_id,
          job_version_id,
          lane,
          priority_score,
          status,
          enqueued_at,
          updated_at
        )
        SELECT
          $1,
          canonical_job_id,
          job_version_id,
          lane,
          priority_score,
          'PENDING',
          NOW(),
          NOW()
        FROM candidates
        WHERE job_version_id IS NOT NULL
          AND lane IS NOT NULL
        ON CONFLICT DO NOTHING
        RETURNING canonical_job_id
      ),
      updated_jobs AS (
        UPDATE canonical_jobs c
        SET processing_state = 'QUEUED_FOR_AI',
            processing_status = 'QUEUED_FOR_AI',
            updated_at = NOW()
        FROM inserted i
        WHERE c.workspace_id = $1
          AND c.id = i.canonical_job_id
          AND COALESCE(c.processing_state, c.processing_status) IN ('LANE_ROUTED', 'MATCHED')
        RETURNING c.id
      )
      SELECT
        (SELECT COUNT(*)::int FROM inserted) AS enqueued,
        (SELECT COUNT(*)::int FROM updated_jobs) AS updated
    `,
      [ctx.workspaceId]
    );

    const summary = rows[0] ?? { enqueued: 0, updated: 0 };
    console.log(
      `Explanation Queue Enqueuer complete. Enqueued: ${summary.enqueued}, Updated: ${summary.updated}`
    );
    return summary;
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as pg.PoolClient).release();
    }
  }
}

export const runEvaluationEnqueuer = runExplanationQueueEnqueuer;
