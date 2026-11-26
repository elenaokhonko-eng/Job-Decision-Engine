/** Reads behind the owner's AI hold. Read only: holding work writes nothing. */

export interface EvaluationQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface HeldAiWorkCounts {
  /** ENQUEUE_EXPLANATION tasks waiting (PENDING or RETRY_WAIT). */
  waitingExplanationTasks: number;
  /** evaluation_queue rows waiting for the processor (PENDING, RETRY_WAIT or EVALUATING). */
  waitingEvaluations: number;
  /** Live eligible jobs in an AI outcome with no evaluation of their current version and decision. */
  jobsWithoutEvaluation: number;
}

export async function selectJobVersionScoreAbove(
  db: EvaluationQueryable,
  workspaceId: string,
  jobVersionId: string,
  scoreCutoff: number,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1
       FROM job_versions v
       JOIN canonical_jobs c ON c.workspace_id = v.workspace_id AND c.id = v.canonical_job_id
      WHERE v.workspace_id = $1::uuid AND v.id = $2::uuid
        AND c.recommendation_requirement_score > $3::numeric`,
    [workspaceId, jobVersionId, scoreCutoff],
  );
  return rows.length > 0;
}

export async function selectHeldAiWorkCounts(
  db: EvaluationQueryable,
  workspaceId: string,
  outcomes: readonly string[],
): Promise<HeldAiWorkCounts> {
  const { rows } = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM pipeline_tasks t
         WHERE t.workspace_id = $1::uuid AND t.task_type = 'ENQUEUE_EXPLANATION'
           AND t.status IN ('PENDING', 'RETRY_WAIT')) AS tasks,
       (SELECT COUNT(*)::int FROM evaluation_queue q
         WHERE q.workspace_id = $1::uuid AND q.status IN ('PENDING', 'RETRY_WAIT', 'EVALUATING')) AS evaluations,
       (SELECT COUNT(*)::int FROM canonical_jobs c
         WHERE c.workspace_id = $1::uuid AND c.archived_at IS NULL AND c.is_test_fixture IS NOT TRUE
           AND c.recommendation_eligibility = 'ELIGIBLE' AND c.recommendation_outcome = ANY($2::text[])
           AND NOT EXISTS (
             SELECT 1 FROM ai_evaluations e
              WHERE e.workspace_id = c.workspace_id AND e.canonical_job_id = c.id
                AND e.job_version_id = c.latest_job_version_id
                AND e.deterministic_decision_id = c.latest_deterministic_decision_id)) AS jobs`,
    [workspaceId, [...outcomes]],
  );
  return {
    waitingExplanationTasks: Number(rows[0]?.tasks ?? 0),
    waitingEvaluations: Number(rows[0]?.evaluations ?? 0),
    jobsWithoutEvaluation: Number(rows[0]?.jobs ?? 0),
  };
}
