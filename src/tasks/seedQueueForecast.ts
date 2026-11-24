/**
 * Read-only forecast of what the first worker run queues after a rule-version change, per stage,
 * and how much embedding work is missing in the active space. Counts only: no ids, titles or employers,
 * and nothing is written (the caller runs it in a READ ONLY transaction). The selection rules mirror the
 * stage seeds in stageTaskWorker.ts; they are counts of jobs, not capped by the per-type limit, so the
 * number of worker passes is count / PIPELINE_TASK_WORKER_MAX_SEED_PER_TYPE.
 */
import type pg from "pg";

import { GATE_VERSION } from "../contracts/version.js";
import { routableWorkabilityVerificationSql } from "../pipeline/verificationRouting.js";
import { profileMatchSupersededSql } from "../pipeline/profileMatchCurrency.js";
import { DETERMINISTIC_EXTRACTOR_VERSION } from "../requirements/deterministicExtractors.js";

type Queryable = Pick<pg.PoolClient, "query">;

export interface SeedQueueForecast {
  readonly liveJobs: number;
  readonly extractorWouldQueue: number;
  readonly gateWouldQueue: number;
  readonly matcherWouldQueue: number;
  /** Jobs in the lane-routing seed pool; each gets a new task key once the router rule version is new. */
  readonly laneRouterPool: number;
  readonly embedding: {
    readonly activeSpaces: number;
    readonly inputsMissingInActiveSpace: number;
    readonly charsMissingInActiveSpace: number;
  };
}

async function count(db: Queryable, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await db.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

export async function forecastFirstRunQueue(db: Queryable, workspaceId: string): Promise<SeedQueueForecast> {
  const live = "c.archived_at IS NULL AND NOT c.is_test_fixture";
  const liveJobs = await count(db, `SELECT COUNT(*) AS n FROM canonical_jobs c WHERE c.workspace_id = $1::uuid AND ${live}`, [workspaceId]);

  const extractorWouldQueue = await count(db, `
    SELECT COUNT(*) AS n FROM canonical_jobs c
      JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
     WHERE c.workspace_id = $1::uuid AND ${live}
       AND COALESCE(c.processing_state, c.processing_status) IN
           ('RAW_STAGED', 'PREQUALIFIED', 'LANE_ROUTED', 'ROUTING_DEFERRED', 'MATCHED', 'QUEUED_FOR_AI', 'EVALUATING', 'AI_EVALUATED', 'EVALUATED')
       AND NOT EXISTS (
         SELECT 1 FROM job_version_pipeline_state ps
           JOIN requirement_extraction_runs rer ON rer.workspace_id = ps.workspace_id AND rer.job_version_id = ps.job_version_id
            AND rer.run_type = 'DETERMINISTIC' AND rer.status = 'COMPLETED' AND jv.active_requirement_set_id IS NOT NULL
            AND rer.requirement_set_id = jv.active_requirement_set_id
           JOIN requirement_sets active_set ON active_set.workspace_id = rer.workspace_id AND active_set.id = rer.requirement_set_id
           JOIN requirement_set_identities active_identity ON active_identity.workspace_id = active_set.workspace_id
            AND active_identity.id = active_set.requirement_identity_id AND active_identity.deterministic_extractor_version = $2
          WHERE ps.workspace_id = c.workspace_id AND ps.job_version_id = jv.id
            AND ps.current_stage = 'REQUIREMENTS_EXTRACTED' AND ps.stage_status = 'COMPLETED')`,
  [workspaceId, DETERMINISTIC_EXTRACTOR_VERSION]);

  const gateWouldQueue = await count(db, `
    SELECT COUNT(*) AS n FROM canonical_jobs c
      JOIN LATERAL (SELECT g.gate_version FROM gate_decisions g
                     WHERE g.workspace_id = c.workspace_id AND g.job_version_id = c.latest_job_version_id
                     ORDER BY g.created_at DESC, g.id DESC LIMIT 1) latest_gate ON TRUE
     WHERE c.workspace_id = $1::uuid AND ${live}
       AND COALESCE(c.processing_state, c.processing_status) NOT IN ('RAW_STAGED', 'MANUALLY_REMOVED')
       AND latest_gate.gate_version IS DISTINCT FROM $2`,
  [workspaceId, GATE_VERSION]);

  const matcherWouldQueue = await count(db, `
    SELECT COUNT(*) AS n FROM canonical_jobs c
      LEFT JOIN match_runs mr ON mr.workspace_id = c.workspace_id AND mr.id = c.latest_match_run_id
     WHERE c.workspace_id = $1::uuid AND ${live} AND ${profileMatchSupersededSql("c", "mr")}`,
  [workspaceId]);

  const laneRouterPool = await count(db, `
    SELECT COUNT(*) AS n FROM canonical_jobs c
     WHERE c.workspace_id = $1::uuid AND ${live}
       AND (COALESCE(c.processing_state, c.processing_status) = 'PREQUALIFIED' OR ${routableWorkabilityVerificationSql("c")}
            OR COALESCE(c.processing_state, c.processing_status) IN ('ROUTING_DEFERRED', 'UNMATCHED'))`,
  [workspaceId]);

  const { rows: space } = await db.query<{ spaces: string; inputs: string; chars: string }>(`
    WITH active AS (SELECT id FROM embedding_spaces WHERE workspace_id = $1::uuid AND active = TRUE AND is_fallback_space = FALSE)
    SELECT (SELECT COUNT(*) FROM active) AS spaces,
           COUNT(*) AS inputs,
           COALESCE(SUM(LENGTH(ei.content_text)), 0) AS chars
      FROM embedding_inputs ei
     WHERE ei.workspace_id = $1::uuid AND ei.is_current = TRUE
       AND EXISTS (SELECT 1 FROM active)
       AND NOT EXISTS (
         SELECT 1 FROM v_published_semantic_embeddings se
          WHERE se.workspace_id = ei.workspace_id AND se.embedding_input_id = ei.id
            AND se.embedding_space_id IN (SELECT id FROM active))`,
  [workspaceId]);

  return {
    liveJobs,
    extractorWouldQueue,
    gateWouldQueue,
    matcherWouldQueue,
    laneRouterPool,
    embedding: {
      activeSpaces: Number(space[0]?.spaces ?? 0),
      inputsMissingInActiveSpace: Number(space[0]?.inputs ?? 0),
      charsMissingInActiveSpace: Number(space[0]?.chars ?? 0),
    },
  };
}
