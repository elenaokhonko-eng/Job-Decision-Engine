/** Reads behind the owner's AI hold. Read only: holding work writes nothing. */
import type { AiScoreApproval } from "../../config/index.js";

export interface EvaluationQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface HeldAiWorkCounts {
  /** ENQUEUE_EXPLANATION tasks waiting to be claimed: PENDING, RETRY_WAIT, or RUNNING with an expired lease. */
  waitingExplanationTasks: number;
  /** Of those, RUNNING tasks whose lease has expired (an interrupted run). */
  expiredLeaseExplanationTasks: number;
  /** ENQUEUE_EXPLANATION tasks blocked because their job did not qualify under the approved cut-off and policy. */
  blockedOnScoreCutoff: number;
  /** evaluation_queue rows not finished (PENDING, RETRY_WAIT or EVALUATING). */
  waitingEvaluations: number;
  /** Of those, rows whose job does not qualify under the open switch; NULL while the switch is closed. */
  queueRowsNotApproved: number | null;
  /** Live eligible jobs in an AI outcome with no evaluation of their current version and decision. */
  jobsWithoutEvaluation: number;
}

export async function selectJobVersionQualifies(
  db: EvaluationQueryable,
  workspaceId: string,
  jobVersionId: string,
  approval: AiScoreApproval,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1
       FROM job_versions v
       JOIN canonical_jobs c ON c.workspace_id = v.workspace_id AND c.id = v.canonical_job_id
      WHERE v.workspace_id = $1::uuid AND v.id = $2::uuid
        AND c.recommendation_requirement_score > $3::numeric
        AND c.recommendation_score_policy = $4::text`,
    [workspaceId, jobVersionId, approval.scoreCutoff, approval.scorePolicy],
  );
  return rows.length > 0;
}

export async function selectHeldAiWorkCounts(
  db: EvaluationQueryable,
  workspaceId: string,
  outcomes: readonly string[],
  approval: AiScoreApproval | null,
  /** Jobs left out of every count (the lead read model's job ids). */
  excludedCanonicalJobIds: readonly string[] = [],
): Promise<HeldAiWorkCounts> {
  const { rows } = await db.query(
    `WITH tasks AS (
       SELECT t.status, t.blocked_on,
              (t.status = 'RUNNING' AND t.lease_expires_at <= NOW()) AS lease_expired
         FROM pipeline_tasks t
        WHERE t.workspace_id = $1::uuid AND t.task_type = 'ENQUEUE_EXPLANATION'
          AND NOT EXISTS (
            SELECT 1 FROM job_versions v
             WHERE v.workspace_id = t.workspace_id AND v.id::text = t.payload->>'job_version_id'
               AND v.canonical_job_id = ANY($5::uuid[]))),
     queue AS (
       SELECT (c.recommendation_requirement_score > $3::numeric
               AND c.recommendation_score_policy = $4::text) AS qualifies
         FROM evaluation_queue q
         JOIN canonical_jobs c ON c.workspace_id = q.workspace_id AND c.id = q.canonical_job_id
        WHERE q.workspace_id = $1::uuid AND q.status IN ('PENDING', 'RETRY_WAIT', 'EVALUATING')
          AND NOT (q.canonical_job_id = ANY($5::uuid[])))
     SELECT
       (SELECT COUNT(*)::int FROM tasks WHERE status IN ('PENDING', 'RETRY_WAIT') OR lease_expired) AS waiting_tasks,
       (SELECT COUNT(*)::int FROM tasks WHERE lease_expired) AS expired_tasks,
       (SELECT COUNT(*)::int FROM tasks
         WHERE status = 'BLOCKED_DEPENDENCY' AND starts_with(blocked_on, 'AI_SCORE_CUTOFF:')) AS blocked_tasks,
       (SELECT COUNT(*)::int FROM queue) AS evaluations,
       (SELECT COUNT(*)::int FROM queue WHERE qualifies IS NOT TRUE) AS not_qualifying,
       (SELECT COUNT(*)::int FROM canonical_jobs c
         WHERE c.workspace_id = $1::uuid AND c.archived_at IS NULL AND c.is_test_fixture IS NOT TRUE
           AND NOT (c.id = ANY($5::uuid[]))
           AND c.recommendation_eligibility = 'ELIGIBLE' AND c.recommendation_outcome = ANY($2::text[])
           AND NOT EXISTS (
             SELECT 1 FROM ai_evaluations e
              WHERE e.workspace_id = c.workspace_id AND e.canonical_job_id = c.id
                AND e.job_version_id = c.latest_job_version_id
                AND e.deterministic_decision_id = c.latest_deterministic_decision_id)) AS jobs`,
    [workspaceId, [...outcomes], approval?.scoreCutoff ?? null, approval?.scorePolicy ?? null,
      [...excludedCanonicalJobIds]],
  );
  const row = rows[0] ?? {};
  return {
    waitingExplanationTasks: Number(row.waiting_tasks ?? 0),
    expiredLeaseExplanationTasks: Number(row.expired_tasks ?? 0),
    blockedOnScoreCutoff: Number(row.blocked_tasks ?? 0),
    waitingEvaluations: Number(row.evaluations ?? 0),
    queueRowsNotApproved: approval ? Number(row.not_qualifying ?? 0) : null,
    jobsWithoutEvaluation: Number(row.jobs ?? 0),
  };
}
