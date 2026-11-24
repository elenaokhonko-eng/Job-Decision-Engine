/**
 * Read-only diagnosis of must-be-zero violations: for each violating job, which stage owns the fix and
 * what is in flight. Counts and ids only (never titles or employers). The repair planner builds on this.
 */
import type pg from "pg";

import { GATE_VERSION } from "../contracts/version.js";
import type { ZeroCheckResult } from "./integrityZeroChecks.js";

type Queryable = Pick<pg.PoolClient, "query">;

export interface ViolationDiagnosis {
  readonly check: string;
  readonly canonicalJobId: string;
  readonly processingState: string | null;
  readonly outcome: string | null;
  readonly eligibility: string | null;
  readonly latestGateVersion: string | null;
  readonly gateVersionIsCurrent: boolean | null;
  readonly hasMatchRun: boolean;
  readonly activeTasks: readonly string[];
  /** Every task ever queued for the job version, as `TYPE:STATUS` (history, so a completed key that blocks a seed is visible). */
  readonly taskHistory: readonly string[];
  readonly hasPublishedJobEmbedding: boolean;
}

/** Job ids of a check's sample, whatever its id prefix (`stage:id`, `label:id`, bare id). */
function jobIdOf(sample: string): string {
  const last = sample.split(":").pop() ?? sample;
  return last;
}

export async function diagnoseViolations(
  db: Queryable,
  workspaceId: string,
  checks: readonly ZeroCheckResult[],
  names: readonly string[],
): Promise<ViolationDiagnosis[]> {
  const targets = checks.filter((check) => names.includes(check.name) && check.total > 0);
  const out: ViolationDiagnosis[] = [];
  for (const check of targets) {
    for (const sample of check.sample) {
      const id = jobIdOf(sample);
      const { rows } = await db.query<{
        processing_state: string | null; outcome: string | null; eligibility: string | null; gate_version: string | null;
        has_match: boolean; tasks: string[] | null; history: string[] | null; job_embedded: boolean;
      }>(
        `SELECT COALESCE(c.processing_state, c.processing_status) AS processing_state,
                c.recommendation_outcome AS outcome, c.recommendation_eligibility AS eligibility,
                (SELECT gd.gate_version FROM gate_decisions gd
                  WHERE gd.workspace_id = c.workspace_id AND gd.canonical_job_id = c.id
                  ORDER BY gd.created_at DESC, gd.id DESC LIMIT 1) AS gate_version,
                (c.latest_match_run_id IS NOT NULL) AS has_match,
                (SELECT ARRAY_AGG(t.task_type || ':' || t.status)
                   FROM pipeline_tasks t
                  WHERE t.workspace_id = c.workspace_id AND t.status IN ('PENDING', 'RUNNING', 'RETRY_WAIT', 'BLOCKED_DEPENDENCY')
                    AND (t.payload->>'canonical_job_id' = c.id::text OR t.payload->>'job_version_id' = c.latest_job_version_id::text)) AS tasks,
                (SELECT ARRAY_AGG(DISTINCT h.task_type || ':' || h.status) FROM pipeline_tasks h
                  WHERE h.workspace_id = c.workspace_id AND h.payload->>'job_version_id' = c.latest_job_version_id::text) AS history,
                EXISTS (SELECT 1 FROM embedding_inputs ei JOIN v_published_semantic_embeddings se ON se.workspace_id = ei.workspace_id AND se.embedding_input_id = ei.id
                         WHERE ei.workspace_id = c.workspace_id AND ei.source_type = 'JOB_VERSION' AND ei.source_id = c.latest_job_version_id) AS job_embedded
           FROM canonical_jobs c WHERE c.workspace_id = $1::uuid AND c.id = $2::uuid`,
        [workspaceId, id],
      );
      const row = rows[0];
      if (!row) continue;
      out.push({
        check: check.name,
        canonicalJobId: id,
        processingState: row.processing_state,
        outcome: row.outcome,
        eligibility: row.eligibility,
        latestGateVersion: row.gate_version,
        gateVersionIsCurrent: row.gate_version === null ? null : row.gate_version === GATE_VERSION,
        hasMatchRun: row.has_match,
        activeTasks: row.tasks ?? [],
        taskHistory: row.history ?? [],
        hasPublishedJobEmbedding: row.job_embedded,
      });
    }
  }
  return out;
}
