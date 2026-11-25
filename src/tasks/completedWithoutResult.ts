/**
 * "Task completed, no result": a pipeline task is COMPLETED but the artifact that proves its work is
 * missing. A stage that ends without writing its result looks finished and hides the job from every
 * retry, so the reconciler reports it as an error (invariant 7: a broken funnel exits non-zero).
 *
 * Read only. Counts tasks that completed for real: tasks the system closed without running them
 * (repair_action set: archived job, reconciled as satisfied or superseded) are not errors, nor are
 * tasks for a job version that is no longer the current one or a job that is archived or a fixture.
 */
import type pg from "pg";

import { sourceContentEvidencePredicate } from "../pipeline/descriptionQuality.js";
import { DESIGNED_COMPLETION_REPAIR_ACTION_PREFIXES } from "./designedNoOps.js";
import { deciderReachableSql } from "./seedQueryScope.js";

type Queryable = Pick<pg.PoolClient, "query">;

/**
 * SQL predicate (canonical alias, version alias) that is TRUE when the decider can select the job version: a complete
 * description and source content evidence. A version that fails it genuinely cannot be decided; a version that passes it
 * must get a decision row. One definition for the worker and for this check.
 */
export function decidableJobVersionSql(canonicalAlias: string, versionAlias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(canonicalAlias) || !/^[a-z_][a-z0-9_]*$/i.test(versionAlias)) {
    throw new Error("A decidable-version alias must be a plain identifier.");
  }
  return `(${canonicalAlias}.description_quality_status = 'COMPLETE'
    AND ${sourceContentEvidencePredicate(`${canonicalAlias}.workspace_id`, `${versionAlias}.id`)})`;
}

/** Task type -> SQL predicate (alias task, version job_version_id) that is TRUE when the result exists. */
export const COMPLETED_RESULT_PREDICATES: Readonly<Record<string, string>> = {
  APPLY_HARD_GATES: `EXISTS (SELECT 1 FROM gate_decisions result
                              WHERE result.workspace_id = task.workspace_id AND result.job_version_id::text = task.payload->>'job_version_id')`,
  ROUTE_LANE: `EXISTS (SELECT 1 FROM lane_decisions result
                        WHERE result.workspace_id = task.workspace_id AND result.job_version_id::text = task.payload->>'job_version_id')`,
  MATCH_PROFILE_EVIDENCE: `EXISTS (SELECT 1 FROM match_runs result
                                    WHERE result.workspace_id = task.workspace_id AND result.job_version_id::text = task.payload->>'job_version_id')`,
  DECIDE_RECOMMENDATION: `EXISTS (SELECT 1 FROM deterministic_decisions result
                                   WHERE result.workspace_id = task.workspace_id AND result.job_version_id::text = task.payload->>'job_version_id')`,
  RECHECK_AVAILABILITY: `EXISTS (SELECT 1 FROM job_availability_recheck_events result
                                  WHERE result.workspace_id = task.workspace_id AND result.canonical_job_id::text = task.payload->>'canonical_job_id' AND result.task_id = task.id)`,
};

export const COMPLETED_RESULT_TASK_TYPES: readonly string[] = Object.keys(COMPLETED_RESULT_PREDICATES);

/** Process exit code for the reconciler: non-zero when any task completed without a result. */
export function completedWithoutResultExitCode(report: Pick<CompletedWithoutResultReport, "total">): 0 | 1 {
  return report.total > 0 ? 1 : 0;
}

export interface CompletedWithoutResultRow {
  readonly taskId: string;
  readonly taskType: string;
  readonly jobVersionId: string;
  readonly completedAt: string | null;
}

export interface CompletedWithoutResultReport {
  readonly total: number;
  readonly byTaskType: Record<string, number>;
  /** First rows, oldest first; ids only, never job content. */
  readonly sample: readonly CompletedWithoutResultRow[];
}

export async function findTasksCompletedWithoutResult(
  client: Queryable,
  workspaceId: string,
  /** sampleLimit is clamped to 200 for reporting; `all: true` returns every row (the repair path). */
  options: { sampleLimit?: number; all?: boolean } = {},
): Promise<CompletedWithoutResultReport> {
  const sampleLimit = options.all ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.min(options.sampleLimit ?? 20, 200));
  const missing = Object.entries(COMPLETED_RESULT_PREDICATES)
    .map(([type, exists]) => `(task.task_type = '${type}' AND NOT ${exists})`)
    .join("\n          OR ");
  const { rows } = await client.query<{ task_id: string; task_type: string; job_version_id: string; completed_at: Date | null }>(
    `SELECT task.id::text AS task_id, task.task_type, task.payload->>'job_version_id' AS job_version_id, task.completed_at
       FROM pipeline_tasks task
       JOIN job_versions version
         ON version.workspace_id = task.workspace_id AND version.id::text = task.payload->>'job_version_id'
       JOIN canonical_jobs canonical
         ON canonical.workspace_id = version.workspace_id AND canonical.id = version.canonical_job_id
      WHERE task.workspace_id = $1::uuid
        AND task.status = 'COMPLETED'
        -- Only a designed repair_action explains a missing result; an unknown one does not hide it.
        AND (task.repair_action IS NULL OR NOT EXISTS (
          SELECT 1 FROM unnest($3::text[]) designed(prefix) WHERE starts_with(task.repair_action, designed.prefix)))
        AND task.task_type = ANY($2::text[])
        AND canonical.latest_job_version_id = version.id
        AND canonical.archived_at IS NULL
        AND canonical.is_test_fixture = FALSE
        AND COALESCE(canonical.processing_state, canonical.processing_status) <> 'MANUALLY_REMOVED'
        -- A technically deferred route (ROUTING_DEFERRED) leaves no lane decision by design; it is its own waiting state.
        AND NOT (task.task_type = 'ROUTE_LANE' AND COALESCE(canonical.processing_state, canonical.processing_status) = 'ROUTING_DEFERRED')
        -- The worker completes a profile match without a match run, by design, for a job that has no match to perform:
        -- no active lane match (UNMATCHED), a technical routing deferral, verification still open, or a hard rejection.
        -- (A task closed after this change also carries a repair_action; these states cover the rows closed before it.)
        AND NOT (task.task_type = 'MATCH_PROFILE_EVIDENCE' AND COALESCE(canonical.processing_state, canonical.processing_status)
                 IN ('UNMATCHED', 'ROUTING_DEFERRED', 'NEEDS_VERIFICATION', 'HARD_REJECTED'))
        -- A decision task for a job still before lane routing is a stale task the worker closes without a decision, by design.
        AND NOT (task.task_type = 'DECIDE_RECOMMENDATION' AND COALESCE(canonical.processing_state, canonical.processing_status)
                 IN ('RAW_STAGED', 'PREQUALIFIED'))
        -- A terminal job whose version the decider cannot select (incomplete description or no source content) cannot get a decision.
        AND NOT (task.task_type = 'DECIDE_RECOMMENDATION' AND COALESCE(canonical.processing_state, canonical.processing_status)
                 IN ('HARD_REJECTED', 'UNMATCHED') AND NOT ${decidableJobVersionSql("canonical", "version")})
        -- An UNMATCHED job the decider cannot reach (no current completed match run) cannot get a decision either.
        AND NOT (task.task_type = 'DECIDE_RECOMMENDATION' AND COALESCE(canonical.processing_state, canonical.processing_status) = 'UNMATCHED'
                 AND NOT (${deciderReachableSql("canonical")}))
        -- RECHECK_AVAILABILITY skips (and completes without an event) a job that has no observation to read.
        AND NOT (task.task_type = 'RECHECK_AVAILABILITY' AND NOT EXISTS (
          SELECT 1 FROM raw_job_observations skip_observation
           WHERE skip_observation.workspace_id = version.workspace_id AND skip_observation.job_version_id = version.id))
        AND (${missing})
      ORDER BY task.completed_at ASC NULLS FIRST, task.id ASC`,
    [workspaceId, [...COMPLETED_RESULT_TASK_TYPES], [...DESIGNED_COMPLETION_REPAIR_ACTION_PREFIXES]],
  );
  const byTaskType: Record<string, number> = {};
  for (const row of rows) byTaskType[row.task_type] = (byTaskType[row.task_type] ?? 0) + 1;
  return {
    total: rows.length,
    byTaskType,
    sample: rows.slice(0, sampleLimit).map((row) => ({
      taskId: row.task_id,
      taskType: row.task_type,
      jobVersionId: row.job_version_id,
      completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    })),
  };
}
