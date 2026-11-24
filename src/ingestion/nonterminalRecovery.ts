import type { Queryable } from "./contentCompleteness.js";

/**
 * Automatic nonterminal jobs must have recoverable work attached: an open pipeline task or an active evaluation queue
 * row. A job without either is stranded. Archived jobs are not live: the archive completes their open tasks as
 * SKIPPED_ARCHIVED_JOB on purpose, so they are never counted. Read only; ids only.
 */
export const NONTERMINAL_STATES = ["RAW_STAGED", "PREQUALIFIED", "ROUTING_DEFERRED", "LANE_ROUTED", "QUEUED_FOR_AI", "EVALUATING", "RETRY_WAIT"] as const;

export const STRANDED_SAMPLE_SIZE = 10;

export interface StrandedReport {
  count: number;
  sample: string[];
}

export async function findStrandedNonterminalJobs(client: Queryable, workspaceId: string): Promise<StrandedReport> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT c.id::text AS id
       FROM canonical_jobs c
      WHERE c.workspace_id = $1::uuid
        AND NOT c.is_test_fixture
        AND c.archived_at IS NULL
        AND COALESCE(c.processing_state, c.processing_status) = ANY($2::text[])
        AND NOT EXISTS (
          SELECT 1 FROM pipeline_tasks task
           WHERE task.workspace_id = c.workspace_id
             AND task.status IN ('PENDING', 'RUNNING', 'RETRY_WAIT', 'BLOCKED_DEPENDENCY')
             AND (task.payload->>'canonical_job_id' = c.id::text
               OR task.payload->>'job_version_id' = c.latest_job_version_id::text)
        )
        AND NOT EXISTS (
          SELECT 1 FROM evaluation_queue evaluation
           WHERE evaluation.workspace_id = c.workspace_id
             AND evaluation.canonical_job_id = c.id
             AND evaluation.status IN ('PENDING', 'RUNNING', 'RETRY_WAIT')
        )
      ORDER BY c.id`,
    [workspaceId, [...NONTERMINAL_STATES]],
  );
  return { count: rows.length, sample: rows.slice(0, STRANDED_SAMPLE_SIZE).map((row) => row.id) };
}
