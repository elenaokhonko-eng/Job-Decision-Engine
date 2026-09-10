import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

export interface ExplanationQueueEnqueuerSummary {
  enqueued: number;
  updated: number;
}

export async function runExplanationQueueEnqueuer(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: {
    context?: WorkspaceContext;
    jobVersionIds?: string[];
    canonicalJobIds?: string[];
    limit?: number;
  }
): Promise<ExplanationQueueEnqueuerSummary> {
  console.log("Starting Explanation Queue Enqueuer (unbounded eligibility)...");
  const pool = clientOrPool || defaultPool;

  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const jobVersionIds = options?.jobVersionIds?.filter(Boolean) ?? [];
    const canonicalJobIds = options?.canonicalJobIds?.filter(Boolean) ?? [];
    const limit = Number.isInteger(options?.limit) && Number(options?.limit) > 0
      ? Number(options?.limit)
      : null;
    const params: unknown[] = [ctx.workspaceId, ctx.userId];
    const jobVersionFilter = jobVersionIds.length > 0
      ? `AND COALESCE(c.latest_job_version_id, lv.id) = ANY($${params.push(jobVersionIds)}::uuid[])`
      : "";
    const canonicalJobFilter = canonicalJobIds.length > 0
      ? `AND c.id = ANY($${params.push(canonicalJobIds)}::uuid[])`
      : "";
    const limitClause = limit ? `LIMIT $${params.push(limit)}` : "";

    const { rows } = await client.query<{
      enqueued: number;
      updated: number;
    }>(
      `
      WITH candidates AS (
        SELECT
          c.id AS canonical_job_id,
          target_jv.id AS job_version_id,
          active_profile.id AS profile_version_id,
          mr.id AS match_run_id,
          dd.id AS deterministic_decision_id,
          target_jv.content_hash AS job_content_hash,
          dd.context_fingerprint,
          c.primary_lane AS lane,
          CASE
            WHEN COALESCE(c.deterministic_match_score, 0) > 0 THEN c.deterministic_match_score::float
            ELSE COALESCE(c.semantic_score, 0)::float
          END AS priority_score
        FROM canonical_jobs c
        LEFT JOIN LATERAL (
          SELECT id, active_requirement_set_id, content_hash
          FROM job_versions
          WHERE canonical_job_id = c.id
            AND workspace_id = $1
          ORDER BY observed_at DESC
          LIMIT 1
        ) lv ON TRUE
        JOIN job_versions target_jv
          ON target_jv.workspace_id = c.workspace_id
         AND target_jv.id = COALESCE(c.latest_job_version_id, lv.id)
        CROSS JOIN LATERAL (
          SELECT pv.id
          FROM profile_versions pv
          WHERE pv.workspace_id = c.workspace_id
            AND pv.status = 'ACTIVE'
          ORDER BY pv.created_at DESC
          LIMIT 1
        ) active_profile
        JOIN match_runs mr
          ON mr.workspace_id = c.workspace_id
         AND mr.id = c.latest_match_run_id
         AND mr.job_version_id = target_jv.id
         AND mr.profile_version_id = active_profile.id
         AND mr.requirement_set_id = target_jv.active_requirement_set_id
         AND mr.job_content_hash = target_jv.content_hash
         AND mr.status = 'COMPLETED'
        JOIN deterministic_decisions dd
          ON dd.workspace_id = c.workspace_id
         AND dd.id = c.latest_deterministic_decision_id
         AND dd.canonical_job_id = c.id
         AND dd.job_version_id = target_jv.id
         AND dd.match_run_id = mr.id
         AND dd.context_fingerprint IS NOT NULL
        WHERE c.workspace_id = $1
          AND EXISTS (
            SELECT 1
            FROM workspace_user_consents wuc
            WHERE wuc.workspace_id = c.workspace_id
              AND wuc.user_id = $2
              AND wuc.consent_key = 'allow_ai_evaluation'
              AND wuc.granted = TRUE
          )
          AND COALESCE(c.processing_state, c.processing_status) IN ('LANE_ROUTED', 'MATCHED', 'QUEUED_FOR_AI')
          AND c.primary_lane IS NOT NULL
          AND c.primary_lane <> 'UNCLASSIFIED'
          AND COALESCE(c.recommendation_eligibility, 'VERIFY') = 'ELIGIBLE'
          AND COALESCE(c.recommendation_outcome, 'TRACK') IN ('PRIORITY', 'REVIEW')
          AND COALESCE(c.processing_state, c.processing_status) <> 'MANUALLY_REMOVED'
          AND NOT EXISTS (
            SELECT 1
            FROM ai_evaluations ae
            WHERE ae.workspace_id = $1
              AND ae.canonical_job_id = c.id
              AND ae.job_version_id = target_jv.id
              AND ae.profile_version_id = active_profile.id
              AND ae.match_run_id = mr.id
              AND ae.deterministic_decision_id = dd.id
              AND ae.job_content_hash = target_jv.content_hash
              AND ae.context_fingerprint = dd.context_fingerprint
          )
          ${jobVersionFilter}
          ${canonicalJobFilter}
        ORDER BY c.created_at ASC, c.id ASC
        ${limitClause}
      ),
      inserted AS (
        INSERT INTO evaluation_queue (
          workspace_id,
          canonical_job_id,
          job_version_id,
          profile_version_id,
          match_run_id,
          deterministic_decision_id,
          job_content_hash,
          context_fingerprint,
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
          profile_version_id,
          match_run_id,
          deterministic_decision_id,
          job_content_hash,
          context_fingerprint,
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
      params
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
