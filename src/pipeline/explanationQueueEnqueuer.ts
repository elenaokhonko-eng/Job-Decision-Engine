import crypto from "crypto";
import pg from "pg";
import dotenv from "dotenv";
import { sha256Hex, stableStringify } from "../config/structuredLoader.js";
import { pgPoolConfig } from "../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import { loadWorkspaceLanesConfig } from "./laneConfigLoader.js";
import { PersistedEvaluationQueueItemSchema } from "../contracts/index.js";
import { supersedeStaleEvaluationQueueRows } from "./evaluationQueueLineage.js";

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

function laneBudgets(configured: Awaited<ReturnType<typeof loadWorkspaceLanesConfig>>): Record<string, {
  budget_limit: number;
  lane_revision_id: string | null;
  lane_config_source: "LANE_REGISTRY_DB" | "FILES";
  lane_config_version: string | null;
}> {
  const revisionsByLane = new Map(
    (configured.activeLaneRevisions ?? []).map((revision) => [revision.laneKey, revision.laneRevisionId])
  );
  return Object.fromEntries(
    Object.entries(configured.config.lanes).map(([lane, definition]) => [
      lane,
      {
        budget_limit: Math.max(0, Math.floor(definition.maximum_ai_interpretations_per_run)),
        lane_revision_id: revisionsByLane.get(lane) ?? null,
        lane_config_source: configured.source,
        lane_config_version: configured.config.version ?? null,
      },
    ])
  );
}

function laneBudgetRunSnapshot(configured: Awaited<ReturnType<typeof loadWorkspaceLanesConfig>>) {
  const budgets = laneBudgets(configured);
  return {
    source: configured.source,
    version: configured.config.version ?? null,
    budgets,
  };
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
    const jobVersionIds = options?.jobVersionIds?.filter(Boolean) ?? [];
    const canonicalJobIds = options?.canonicalJobIds?.filter(Boolean) ?? [];
    const limit = Number.isInteger(options?.limit) && Number(options?.limit) > 0
      ? Number(options?.limit)
      : null;
    const budgetRunId = options?.budgetRunId ?? crypto.randomUUID();
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    // Registry seeding uses upsertLaneRevision, which owns its transaction. Keep
    // that setup outside the enqueue transaction, then re-read the active snapshot
    // inside REPEATABLE READ so the actual run remains atomic and revision-pinned.
    await loadWorkspaceLanesConfig(client as any, {
      context: ctx,
      seedIfEmpty: true,
    });

    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      // Load and pin the registry snapshot inside the transaction so routing and enqueueing
      // cannot observe different active revisions during this budget run.
      const laneConfig = await loadWorkspaceLanesConfig(client as any, {
        context: ctx,
        seedIfEmpty: false,
      });
      const runSnapshot = laneBudgetRunSnapshot(laneConfig);
      const runSnapshotJson = stableStringify(runSnapshot);
      const runSnapshotHash = sha256Hex(runSnapshotJson);
      const budgets = runSnapshot.budgets;

      await supersedeStaleEvaluationQueueRows(client, { workspaceId: ctx.workspaceId });
      const insertedRun = await client.query<{ id: string }>(
        `INSERT INTO ai_evaluation_budget_runs (
           id, workspace_id, lane_config_source, lane_config_version,
           lane_config_hash, lane_config_snapshot
         )
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [budgetRunId, ctx.workspaceId, runSnapshot.source, runSnapshot.version, runSnapshotHash, runSnapshotJson]
      );

      if (insertedRun.rows.length === 0) {
        const existingRun = await client.query<{
          workspace_id: string;
          lane_config_source: string | null;
          lane_config_version: string | null;
          lane_config_hash: string | null;
          lane_config_snapshot: unknown;
        }>(
          `SELECT workspace_id, lane_config_source, lane_config_version,
                  lane_config_hash, lane_config_snapshot
           FROM ai_evaluation_budget_runs
           WHERE id = $1::uuid
           FOR UPDATE`,
          [budgetRunId]
        );
        const persistedRun = existingRun.rows[0];
        if (!persistedRun || persistedRun.workspace_id !== ctx.workspaceId) {
          throw new Error(`AI budget run ${budgetRunId} is not available in this workspace.`);
        }

        if (persistedRun.lane_config_snapshot === null) {
          const previousWork = await client.query<{ has_prior_work: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM ai_evaluation_budget_usage
               WHERE budget_run_id = $1::uuid AND workspace_id = $2::uuid
               UNION ALL
               SELECT 1 FROM evaluation_queue
               WHERE budget_run_id = $1::uuid AND workspace_id = $2::uuid
               UNION ALL
               SELECT 1 FROM evaluation_budget_deferrals
               WHERE budget_run_id = $1::uuid AND workspace_id = $2::uuid
             ) AS has_prior_work`,
            [budgetRunId, ctx.workspaceId]
          );
          if (previousWork.rows[0]?.has_prior_work) {
            throw new Error(
              `AI budget run ${budgetRunId} has prior work but no pinned lane configuration snapshot. Start a new budget run.`
            );
          }
          await client.query(
            `UPDATE ai_evaluation_budget_runs
             SET lane_config_source = $2,
                 lane_config_version = $3,
                 lane_config_hash = $4,
                 lane_config_snapshot = $5::jsonb,
                 last_seen_at = NOW()
             WHERE id = $1::uuid AND workspace_id = $6::uuid`,
            [budgetRunId, runSnapshot.source, runSnapshot.version, runSnapshotHash, runSnapshotJson, ctx.workspaceId]
          );
        } else {
          const storedSnapshot = stableStringify(persistedRun.lane_config_snapshot);
          if (persistedRun.lane_config_hash !== runSnapshotHash
              || persistedRun.lane_config_source !== runSnapshot.source
              || persistedRun.lane_config_version !== runSnapshot.version
              || storedSnapshot !== runSnapshotJson) {
            throw new Error(
              `AI budget run ${budgetRunId} cannot be retried with a different lane configuration snapshot. Start a new budget run.`
            );
          }
          await client.query(
            `UPDATE ai_evaluation_budget_runs
             SET last_seen_at = NOW()
             WHERE id = $1::uuid AND workspace_id = $2::uuid`,
            [budgetRunId, ctx.workspaceId]
          );
        }
      }

      await client.query(
        `INSERT INTO ai_evaluation_budget_usage (
           budget_run_id, workspace_id, lane, budget_limit
         )
         SELECT $1::uuid, $2::uuid, key, GREATEST((value->>'budget_limit')::int, 0)
         FROM jsonb_each($3::jsonb)
         ON CONFLICT (budget_run_id, lane) DO NOTHING`,
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
        runSnapshot.source,
        runSnapshot.version,
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
        lane_revision_mismatch_count: number;
        queue_contract_items: unknown;
      }>(
        `
        WITH lane_budgets AS (
          SELECT
            key AS lane,
            GREATEST((value->>'budget_limit')::int, 0) AS budget_limit,
            NULLIF(value->>'lane_revision_id', '') AS lane_revision_id,
            value->>'lane_config_source' AS lane_config_source,
            value->>'lane_config_version' AS lane_config_version
          FROM jsonb_each($3::jsonb)
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
            route_lane.lane_revision_id AS routed_lane_revision_id,
            CASE
              WHEN COALESCE(lb.lane_config_source, $5::text) = 'FILES' THEN COALESCE(
                ld.lane_snapshot->>'source' = $5::text
                AND (ld.lane_snapshot->>'lanes_version') IS NOT DISTINCT FROM $6::text
                AND ld.decision_json->>'primary_lane' = c.primary_lane,
                FALSE
              )
              WHEN lb.lane IS NULL THEN COALESCE(
                ld.lane_snapshot->>'source' = $5::text
                AND (ld.lane_snapshot->>'lanes_version') IS NOT DISTINCT FROM $6::text
                AND ld.decision_json->>'primary_lane' = c.primary_lane
                AND jsonb_typeof(ld.lane_snapshot->'active_lane_revisions') = 'array'
                AND route_lane.lane_revision_id IS NULL,
                FALSE
              )
              ELSE COALESCE(
                ld.lane_snapshot->>'source' = lb.lane_config_source
                AND (ld.lane_snapshot->>'lanes_version') IS NOT DISTINCT FROM lb.lane_config_version
                AND ld.decision_json->>'primary_lane' = c.primary_lane
                AND jsonb_typeof(ld.lane_snapshot->'active_lane_revisions') = 'array'
                AND route_lane.lane_revision_id IS NOT NULL
                AND route_lane.lane_revision_id = lb.lane_revision_id,
                FALSE
              )
            END AS lane_revision_matches,
            c.created_at AS candidate_created_at,
            COALESCE(bu.selected_count, 0) AS selected_count,
            COALESCE(lb.budget_limit, 0) AS budget_limit,
            (lb.lane IS NOT NULL) AS budget_configured,
            lb.lane_revision_id,
            lb.lane_config_source,
            lb.lane_config_version,
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
          LEFT JOIN lane_decisions ld
            ON ld.workspace_id = c.workspace_id
           AND ld.id = c.latest_lane_decision_id
           AND ld.canonical_job_id = c.id
           AND ld.job_version_id = target_jv.id
          LEFT JOIN LATERAL (
            SELECT revision.value->>'lane_revision_id' AS lane_revision_id
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(ld.lane_snapshot->'active_lane_revisions') = 'array'
                  THEN ld.lane_snapshot->'active_lane_revisions'
                ELSE '[]'::jsonb
              END
            ) AS revision(value)
            WHERE revision.value->>'lane_key' = c.primary_lane
            LIMIT 1
          ) route_lane ON TRUE
          LEFT JOIN lane_budgets lb ON lb.lane = c.primary_lane
          LEFT JOIN budget_usage bu ON bu.lane = c.primary_lane
          WHERE c.workspace_id = $1::uuid
            AND c.archived_at IS NULL
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
        candidates_with_current_lane_revision AS (
          SELECT *
          FROM candidates
          WHERE lane_revision_matches
        ),
        lane_revision_mismatches AS (
          SELECT COUNT(*)::int AS count
          FROM candidates
          WHERE lane_revision_matches IS NOT TRUE
        ),
        capacity_candidates AS (
          SELECT *
          FROM candidates_with_current_lane_revision
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
          FROM candidates_with_current_lane_revision c
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
              'budget_configured', budget_configured,
              'lane_revision_id', lane_revision_id,
              'lane_config_source', lane_config_source,
              'lane_config_version', lane_config_version
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
        )
        SELECT
          (SELECT COUNT(*)::int FROM inserted) AS enqueued,
          (SELECT COUNT(*)::int FROM updated_jobs) AS updated,
          (SELECT COUNT(*)::int FROM deferred_rows) AS deferred,
          (SELECT count FROM lane_revision_mismatches) AS lane_revision_mismatch_count,
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
      const laneRevisionMismatchCount = Number(summary.lane_revision_mismatch_count ?? 0);
      if (laneRevisionMismatchCount > 0) {
        throw new Error(
          `Cannot enqueue ${laneRevisionMismatchCount} job(s): their latest lane decision does not use the active lane revision. Re-run lane routing before AI enqueue.`
        );
      }
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
