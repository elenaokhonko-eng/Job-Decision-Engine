import { listLeadJobIds } from "../modules/catalog/index.js";
import { LEAD_QUEUE_NOTE } from "../pipeline/evaluationQueueLineage.js";
import { readAiWorkSettings, type AiWorkSettings } from "../platform/config/index.js";
import type { Queryable } from "./contentCompleteness.js";

/**
 * Automatic nonterminal jobs must have recoverable work attached: an open pipeline task or an active evaluation queue
 * row. A job without either is stranded. Archived jobs are not live: the archive completes their open tasks as
 * SKIPPED_ARCHIVED_JOB on purpose, so they are never counted. Read only; ids only.
 *
 * One state is parked on purpose: a QUEUED_FOR_AI job whose newest queue row was superseded because it was a lead.
 * It keeps its state (a lead is never rejected), and the recoverable seed queues it again once it is no longer a lead.
 * It is not stranded while it is a lead, while the owner's switch or cut-off admits no AI work for it, or after the
 * AI budget deferred it. Otherwise it is counted until the seed has queued it.
 */
export const NONTERMINAL_STATES = ["RAW_STAGED", "PREQUALIFIED", "ROUTING_DEFERRED", "LANE_ROUTED", "QUEUED_FOR_AI", "EVALUATING", "RETRY_WAIT"] as const;

export const STRANDED_SAMPLE_SIZE = 10;

export interface StrandedReport {
  count: number;
  sample: string[];
}

export async function findStrandedNonterminalJobs(
  client: Queryable,
  workspaceId: string,
  aiWork: AiWorkSettings = readAiWorkSettings(),
): Promise<StrandedReport> {
  const leadIds = await listLeadJobIds(client as never, workspaceId);
  const approval = aiWork.mode === "OPEN" ? aiWork : null;
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
        AND NOT (
          COALESCE(c.processing_state, c.processing_status) = 'QUEUED_FOR_AI'
          AND EXISTS (
            SELECT 1
              FROM (SELECT q.status, q.last_error, q.updated_at
                      FROM evaluation_queue q
                     WHERE q.workspace_id = c.workspace_id
                       AND q.canonical_job_id = c.id
                       AND q.job_version_id = c.latest_job_version_id
                     ORDER BY q.enqueued_at DESC, q.id DESC
                     LIMIT 1) newest
             WHERE newest.status = 'SUPERSEDED'
               AND strpos(newest.last_error, $3::text) > 0
               AND (
                 c.id = ANY($4::uuid[])
                 -- No approval (held) compares with NULL, so the job counts as not admitted.
                 OR NOT COALESCE(c.recommendation_requirement_score > $5::numeric
                                 AND c.recommendation_score_policy = $6::text, FALSE)
                 OR EXISTS (SELECT 1 FROM evaluation_budget_deferrals deferral
                             WHERE deferral.workspace_id = c.workspace_id
                               AND deferral.canonical_job_id = c.id
                               AND deferral.job_version_id = c.latest_job_version_id
                               AND deferral.created_at >= newest.updated_at)
               )
          )
        )
      ORDER BY c.id`,
    [workspaceId, [...NONTERMINAL_STATES], LEAD_QUEUE_NOTE, leadIds,
      approval?.scoreCutoff ?? null, approval?.scorePolicy ?? null],
  );
  return { count: rows.length, sample: rows.slice(0, STRANDED_SAMPLE_SIZE).map((row) => row.id) };
}
