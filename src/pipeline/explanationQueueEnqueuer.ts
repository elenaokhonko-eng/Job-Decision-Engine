import crypto from "crypto";
import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import { loadLanesConfig } from "./laneConfigLoader.js";
import { PersistedEvaluationQueueItemSchema } from "../contracts/index.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

export interface ExplanationQueueEnqueuerSummary {
  enqueued: number;
  updated: number;
  deferred: number;
}

function normalizePersistedTimestamp(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function laneBudgets(): Record<string, number> {
  const configured = loadLanesConfig().lanes;
  return Object.fromEntries(
    Object.entries(configured).map(([lane, definition]) => [
      lane,
      Math.max(0, Math.floor(definition.maximum_ai_interpretations_per_run)),
    ])
  );
}

export async function runExplanationQueueEnqueuer(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: {
    context?: WorkspaceContext;
    jobVersionIds?: string[];
    canonicalJobIds?: string[];
    limit?: number;
    budgetRunId?: string;
  }
): Promise<ExplanationQueueEnqueuerSummary> {
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
    const budgetRunId = options?.budgetRunId ?? crypto.randomUUID();
    const budgets = laneBudgets();

    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO ai_evaluation_budget_runs (id, workspace_id)
         VALUES ($1::uuid, $2::uuid)
         ON CONFLICT (id) DO UPDATE SET last_seen_at = NOW()`,
        [budgetRunId, ctx.workspaceId]
      );
      await client.query(
        `INSERT INTO ai_evaluation_budget_usage (
           budget_run_id, workspace_id, lane, budget_limit
         )
         SELECT $1::uuid, $2::uuid, key, GREATEST(value::int, 0)
         FROM jsonb_each_text($3::jsonb)
         ON CONFLICT (budget_run_id, lane) DO UPDATE
           SET budget_limit = EXCLUDED.budget_limit,
               updated_at = NOW()`,
        [budgetRunId, ctx.workspaceId, JSON.stringify(budgets)]
      );
      await client.query(
        `SELECT lane
         FROM ai_evaluation_budget_usage
         WHERE budget_run_id = $1::uuid AND workspace_id = $2::uuid
         FOR UPDATE`,
        [budgetRunId, ctx.workspaceId]
      );

      const params: unknown[] = [
        ctx.workspaceId,
        budgetRunId,
        JSON.stringify(budgets),
        limit,
      ];
      const jobVersionFilter = jobVersionIds.length > 0
        ? `AND COALESCE(c.latest_job_version_id, lv.id) = ANY($${params.push(jobVersionIds)}::uuid[])`
        : "";
      const canonicalJobFilter = canonicalJobIds.length > 0
        ? `AND c.id = ANY($${params.push(canonicalJobIds)}::uuid[])`
        : "";

      const { rows } = await client.query<{
        enqueued: number;
        updated: number;
        deferred: number;
        queue_contract_items: unknown;
      }>(
        `
        WITH lane_budgets AS (
          SELECT key AS lane, GREATEST(value::int, 0) AS budget_limit
          FROM jsonb_each_text($3::jsonb)
        ),
        budget_usage AS (
          SELECT lane, budget_limit, selected_count
          FROM ai_evaluation_budget_usage
          WHERE budget_run_id = $2::uuid
            AND workspace_id = $1::uuid
        ),
        candidates AS (
          SELECT
            c.id AS canonical_job_id,
            target_jv.id AS job_version_id,
            active_profile.id AS profile_version_id,
            mr.id AS match_run_id,
            dd.id AS deterministic_decision_id,
            target_jv.content_hash AS job_content_hash,
            dd.context_fingerprint,
            c.primary_lane AS lane,
            c.created_at AS candidate_created_at,
            COALESCE(bu.selected_count, 0) AS selected_count,
            COALESCE(lb.budget_limit, 0) AS budget_limit,
            (lb.lane IS NOT NULL) AS budget_configured,
            CASE
              WHEN COALESCE(c.deterministic_match_score, 0) > 0 THEN c.deterministic_match_score::float
              ELSE COALESCE(c.semantic_score, 0)::float
            END AS priority_score,
            ROW_NUMBER() OVER (
              PARTITION BY c.primary_lane
              ORDER BY
                CASE WHEN COALESCE(c.processing_state, c.processing_status) = 'DEFERRED_BUDGET' THEN 0 ELSE 1 END,
                CASE
                  WHEN COALESCE(c.deterministic_match_score, 0) > 0 THEN c.deterministic_match_score::float
                  ELSE COALESCE(c.semantic_score, 0)::float
                END DESC,
                c.created_at ASC,
                c.id ASC
            ) AS lane_rank
          FROM canonical_jobs c
          LEFT JOIN LATERAL (
            SELECT id, active_requirement_set_id, content_hash
            FROM job_versions
            WHERE canonical_job_id = c.id
              AND workspace_id = $1::uuid
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
          LEFT JOIN lane_budgets lb ON lb.lane = c.primary_lane
          LEFT JOIN budget_usage bu ON bu.lane = c.primary_lane
          WHERE c.workspace_id = $1::uuid
            AND COALESCE(c.processing_state, c.processing_status) IN ('LANE_ROUTED', 'MATCHED', 'QUEUED_FOR_AI', 'DEFERRED_BUDGET')
            AND c.primary_lane IS NOT NULL
            AND c.primary_lane <> 'UNCLASSIFIED'
            AND COALESCE(c.recommendation_eligibility, 'VERIFY') = 'ELIGIBLE'
            AND COALESCE(c.recommendation_outcome, 'TRACK') IN ('PRIORITY', 'REVIEW', 'TRACK')
            AND COALESCE(c.processing_state, c.processing_status) <> 'MANUALLY_REMOVED'
            AND NOT EXISTS (
              SELECT 1
              FROM ai_evaluations ae
              WHERE ae.workspace_id = $1::uuid
                AND ae.canonical_job_id = c.id
                AND ae.job_version_id = target_jv.id
                AND ae.profile_version_id = active_profile.id
                AND ae.match_run_id = mr.id
                AND ae.deterministic_decision_id = dd.id
                AND ae.job_content_hash = target_jv.content_hash
                AND ae.context_fingerprint = dd.context_fingerprint
            )
            AND NOT EXISTS (
              SELECT 1
              FROM evaluation_queue eq
              WHERE eq.workspace_id = $1::uuid
                AND eq.canonical_job_id = c.id
                AND eq.job_version_id = target_jv.id
                AND eq.profile_version_id = active_profile.id
                AND eq.match_run_id = mr.id
                AND eq.deterministic_decision_id = dd.id
                AND eq.job_content_hash = target_jv.content_hash
                AND eq.context_fingerprint = dd.context_fingerprint
                AND eq.status IN ('PENDING', 'EVALUATING', 'RETRY_WAIT')
            )
            ${jobVersionFilter}
            ${canonicalJobFilter}
        ),
        capacity_candidates AS (
          SELECT *
          FROM candidates
          WHERE lane_rank <= GREATEST(budget_limit - selected_count, 0)
        ),
        fair_ranked AS (
          SELECT capacity_candidates.*,
                 ROW_NUMBER() OVER (
                   ORDER BY lane_rank ASC, lane ASC, candidate_created_at ASC, canonical_job_id ASC
                 ) AS fair_rank
          FROM capacity_candidates
        ),
        selected AS (
          SELECT *
          FROM fair_ranked
          WHERE $4::int IS NULL OR fair_rank <= $4::int
        ),
        deferred_candidates AS (
          SELECT c.*, NULL::bigint AS fair_rank
          FROM candidates c
          WHERE c.lane_rank > GREATEST(c.budget_limit - c.selected_count, 0)
          UNION ALL
          SELECT fr.*
          FROM fair_ranked fr
          WHERE $4::int IS NOT NULL AND fr.fair_rank > $4::int
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
            budget_run_id,
            status,
            enqueued_at,
            updated_at
          )
          SELECT
            $1::uuid,
            canonical_job_id,
            job_version_id,
            profile_version_id,
            match_run_id,
            deterministic_decision_id,
            job_content_hash,
            context_fingerprint,
            lane,
            priority_score,
            $2::uuid,
            'PENDING',
            NOW(),
            NOW()
          FROM selected
          WHERE job_version_id IS NOT NULL
            AND lane IS NOT NULL
          ON CONFLICT DO NOTHING
          RETURNING
            id,
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
            budget_run_id,
            available_at,
            lease_id,
            lease_expires_at,
            attempt_count,
            max_attempts,
            last_error,
            enqueued_at,
            updated_at
        ),
        deferred_rows AS (
          INSERT INTO evaluation_budget_deferrals (
            workspace_id,
            canonical_job_id,
            job_version_id,
            budget_run_id,
            lane,
            budget_limit,
            lane_rank,
            reason_code,
            evidence
          )
          SELECT
            $1::uuid,
            canonical_job_id,
            job_version_id,
            $2::uuid,
            lane,
            budget_limit,
            lane_rank,
            CASE
              WHEN budget_configured THEN 'AI_BUDGET_EXHAUSTED'
              ELSE 'AI_BUDGET_UNCONFIGURED_LANE'
            END,
            jsonb_build_object(
              'selected_count', selected_count,
              'fair_rank', fair_rank,
              'priority_score', priority_score,
              'budget_configured', budget_configured
            )
          FROM deferred_candidates
          WHERE job_version_id IS NOT NULL
            AND lane IS NOT NULL
          ON CONFLICT (budget_run_id, canonical_job_id, job_version_id) DO NOTHING
          RETURNING canonical_job_id
        ),
        updated_jobs AS (
          UPDATE canonical_jobs c
          SET processing_state = 'QUEUED_FOR_AI',
              processing_status = 'QUEUED_FOR_AI',
              updated_at = NOW()
          FROM inserted i
          WHERE c.workspace_id = $1::uuid
            AND c.id = i.canonical_job_id
            AND COALESCE(c.processing_state, c.processing_status) IN ('LANE_ROUTED', 'MATCHED', 'DEFERRED_BUDGET')
          RETURNING c.id
        ),
        updated_deferred_jobs AS (
          UPDATE canonical_jobs c
          SET processing_state = 'DEFERRED_BUDGET',
              processing_status = 'DEFERRED_BUDGET',
              updated_at = NOW()
          FROM deferred_candidates d
          WHERE c.workspace_id = $1::uuid
            AND c.id = d.canonical_job_id
            AND COALESCE(c.processing_state, c.processing_status) IN ('LANE_ROUTED', 'MATCHED', 'QUEUED_FOR_AI', 'DEFERRED_BUDGET')
          RETURNING c.id
        )
        SELECT
          (SELECT COUNT(*)::int FROM inserted) AS enqueued,
          (SELECT COUNT(*)::int FROM updated_jobs) AS updated,
          (SELECT COUNT(*)::int FROM deferred_rows) AS deferred,
          COALESCE(
            (
              SELECT jsonb_agg(
                to_jsonb(inserted) || jsonb_build_object('schema_version', '2.2.0')
              )
              FROM inserted
            ),
            '[]'::jsonb
          ) AS queue_contract_items
      `,
        params
      );

      const summary = rows[0] ?? { enqueued: 0, updated: 0, deferred: 0, queue_contract_items: [] };
      const queueContractItems = Array.isArray(summary.queue_contract_items)
        ? summary.queue_contract_items.map((item: any) => PersistedEvaluationQueueItemSchema.parse({
            ...item,
            available_at: normalizePersistedTimestamp(item.available_at),
            lease_expires_at: normalizePersistedTimestamp(item.lease_expires_at),
            enqueued_at: normalizePersistedTimestamp(item.enqueued_at),
            updated_at: normalizePersistedTimestamp(item.updated_at),
          }))
        : [];
      if (queueContractItems.length !== Number(summary.enqueued ?? 0)) {
        throw new Error(
          `Evaluation queue contract count mismatch: inserted=${summary.enqueued ?? 0}, validated=${queueContractItems.length}`
        );
      }

      const result: ExplanationQueueEnqueuerSummary = {
        enqueued: Number(summary.enqueued ?? 0),
        updated: Number(summary.updated ?? 0),
        deferred: Number(summary.deferred ?? 0),
      };

      await client.query(
        `UPDATE ai_evaluation_budget_usage u
        SET selected_count = selected.lane_count,
             updated_at = NOW()
         FROM (
           SELECT lane, COUNT(*)::int AS lane_count
           FROM evaluation_queue
           WHERE workspace_id = $1::uuid
             AND budget_run_id = $2::uuid
           GROUP BY lane
         ) selected
         WHERE u.workspace_id = $1::uuid
           AND u.budget_run_id = $2::uuid
           AND u.lane = selected.lane`,
        [ctx.workspaceId, budgetRunId]
      );

      await client.query("COMMIT");
      console.log(
        `Explanation Queue Enqueuer complete. Enqueued: ${result.enqueued}, Updated: ${result.updated}, Deferred: ${result.deferred}`
      );
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as pg.PoolClient).release();
    }
  }
}

export const runEvaluationEnqueuer = runExplanationQueueEnqueuer;
