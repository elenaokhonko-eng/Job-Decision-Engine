import pg from "pg";

export interface EvaluationQueueCandidate extends pg.QueryResultRow {
  id: string;
  canonical_job_id: string;
  job_version_id: string;
  lane: string;
  priority_score: number;
  status: string;
  attempt_count: number;
  max_attempts: number | null;
  available_at: Date | string | null;
  normalized_title: string;
  company_name: string;
  canonical_url: string;
  gate_decision: string | null;
  workability_facts: unknown;
  description_text: string | null;
  resolved_gate_decision_id: string | null;
  profile_version_id: string;
  match_run_id: string;
  deterministic_decision_id: string;
  job_content_hash: string;
  context_fingerprint: string;
}

export interface EvaluationQueueSelection {
  readonly workspaceId: string;
  readonly profileVersionId?: string;
  readonly jobVersionIds?: readonly string[];
  readonly enqueuedAtOrAfter?: Date | string;
  readonly limit?: number;
}

export interface EvaluationQueueReconciliation {
  readonly workspaceId: string;
  readonly profileVersionId?: string;
}

export async function selectEligibleEvaluationQueueRows(
  client: pg.Pool | pg.PoolClient,
  selection: EvaluationQueueSelection,
): Promise<EvaluationQueueCandidate[]> {
  if (selection.limit !== undefined && (!Number.isInteger(selection.limit) || selection.limit < 1 || selection.limit > 1000)) {
    throw new Error("Evaluation queue limit must be an integer from 1 to 1000.");
  }

  const params: unknown[] = [selection.workspaceId];
  const profileFilter = selection.profileVersionId
    ? `AND eq.profile_version_id = $${params.push(selection.profileVersionId)}::uuid`
    : "";
  const jobVersionFilter = selection.jobVersionIds && selection.jobVersionIds.length > 0
    ? `AND eq.job_version_id = ANY($${params.push([...selection.jobVersionIds])}::uuid[])`
    : "";
  const enqueuedAfterFilter = selection.enqueuedAtOrAfter !== undefined
    ? `AND eq.enqueued_at >= $${params.push(selection.enqueuedAtOrAfter)}`
    : "";
  const limitClause = selection.limit !== undefined
    ? `LIMIT $${params.push(selection.limit)}`
    : "";

  const { rows } = await client.query<EvaluationQueueCandidate>(
    `SELECT eq.*, c.normalized_title, c.company_name, c.canonical_url,
            c.gate_decision, c.workability_facts,
            jv.description_text,
            gd.id AS resolved_gate_decision_id
     FROM evaluation_queue eq
     JOIN canonical_jobs c
       ON c.id = eq.canonical_job_id
      AND c.workspace_id = eq.workspace_id
     JOIN job_versions jv
       ON jv.id = eq.job_version_id
      AND jv.workspace_id = eq.workspace_id
      AND jv.canonical_job_id = eq.canonical_job_id
     JOIN deterministic_decisions dd
       ON dd.workspace_id = eq.workspace_id
      AND dd.id = eq.deterministic_decision_id
      AND dd.canonical_job_id = eq.canonical_job_id
      AND dd.job_version_id = eq.job_version_id
      AND dd.match_run_id = eq.match_run_id
      AND dd.context_fingerprint = eq.context_fingerprint
     LEFT JOIN LATERAL (
       SELECT gd.id
       FROM gate_decisions gd
       WHERE gd.workspace_id = eq.workspace_id
         AND gd.canonical_job_id = eq.canonical_job_id
         AND gd.job_version_id = eq.job_version_id
       ORDER BY gd.created_at DESC, gd.id DESC
       LIMIT 1
     ) gd ON TRUE
     WHERE eq.workspace_id = $1
       ${profileFilter}
       ${jobVersionFilter}
       ${enqueuedAfterFilter}
       AND (
         eq.status = 'PENDING'
         OR (eq.status = 'RETRY_WAIT' AND (eq.available_at IS NULL OR eq.available_at <= NOW()))
         OR (eq.status = 'EVALUATING' AND eq.lease_expires_at < NOW())
       )
       AND eq.profile_version_id IS NOT NULL
       AND c.archived_at IS NULL
       AND eq.job_version_id = c.latest_job_version_id
       AND eq.match_run_id = c.latest_match_run_id
       AND eq.deterministic_decision_id = c.latest_deterministic_decision_id
       AND eq.job_content_hash = jv.content_hash
       AND eq.context_fingerprint IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM profile_versions pv
         WHERE pv.workspace_id = eq.workspace_id
           AND pv.id = eq.profile_version_id
           AND pv.status = 'ACTIVE'
       )
       AND EXISTS (
         SELECT 1
         FROM match_runs mr
         WHERE mr.workspace_id = eq.workspace_id
           AND mr.id = eq.match_run_id
           AND mr.canonical_job_id = eq.canonical_job_id
           AND mr.job_version_id = eq.job_version_id
           AND mr.profile_version_id = eq.profile_version_id
           AND mr.requirement_set_id = jv.active_requirement_set_id
           AND mr.job_content_hash = jv.content_hash
           AND mr.context_fingerprint IS NOT NULL
           AND mr.status = 'COMPLETED'
       )
     ORDER BY eq.priority_score DESC, eq.enqueued_at ASC
     ${limitClause}`,
    params,
  );

  return rows;
}

export async function supersedeStaleEvaluationQueueRows(
  client: pg.Pool | pg.PoolClient,
  reconciliation: EvaluationQueueReconciliation,
): Promise<number> {
  const params: unknown[] = [reconciliation.workspaceId];
  const profileFilter = reconciliation.profileVersionId
    ? `AND eq.profile_version_id = $${params.push(reconciliation.profileVersionId)}::uuid`
    : "";
  const { rowCount } = await client.query(
    `UPDATE evaluation_queue eq
     SET status = CASE WHEN EXISTS (
           SELECT 1 FROM canonical_jobs archived_job
           WHERE archived_job.workspace_id = eq.workspace_id
             AND archived_job.id = eq.canonical_job_id
             AND archived_job.archived_at IS NOT NULL
         ) THEN 'SKIPPED_ARCHIVED' ELSE 'SUPERSEDED' END,
         skipped_at = CASE WHEN EXISTS (
           SELECT 1 FROM canonical_jobs archived_job
           WHERE archived_job.workspace_id = eq.workspace_id
             AND archived_job.id = eq.canonical_job_id
             AND archived_job.archived_at IS NOT NULL
         ) THEN NOW() ELSE NULL END,
         skip_reason_code = CASE WHEN EXISTS (
           SELECT 1 FROM canonical_jobs archived_job
           WHERE archived_job.workspace_id = eq.workspace_id
             AND archived_job.id = eq.canonical_job_id
             AND archived_job.archived_at IS NOT NULL
         ) THEN 'JOB_ARCHIVED' ELSE NULL END,
         available_at = NULL,
         lease_id = NULL,
         lease_expires_at = NULL,
         last_error = CASE
           WHEN EXISTS (
             SELECT 1 FROM canonical_jobs archived_job
             WHERE archived_job.workspace_id = eq.workspace_id
               AND archived_job.id = eq.canonical_job_id
               AND archived_job.archived_at IS NOT NULL
           ) THEN NULL
           WHEN COALESCE(BTRIM(eq.last_error), '') = ''
             THEN 'SUPERSEDED: queue lineage is no longer authoritative.'
           ELSE eq.last_error || E'\\nSUPERSEDED: queue lineage is no longer authoritative.'
         END,
         updated_at = NOW()
     WHERE eq.workspace_id = $1
       ${profileFilter}
       AND (
         eq.status IN ('PENDING', 'RETRY_WAIT')
         OR (eq.status = 'EVALUATING' AND eq.lease_expires_at < NOW())
       )
       AND (
         EXISTS (
           SELECT 1 FROM canonical_jobs archived_job
           WHERE archived_job.workspace_id = eq.workspace_id
             AND archived_job.id = eq.canonical_job_id
             AND archived_job.archived_at IS NOT NULL
         )
         OR NOT EXISTS (
         SELECT 1
         FROM canonical_jobs c
         JOIN job_versions jv
           ON jv.workspace_id = c.workspace_id
          AND jv.id = c.latest_job_version_id
          AND jv.canonical_job_id = c.id
         JOIN profile_versions pv
           ON pv.workspace_id = c.workspace_id
          AND pv.id = eq.profile_version_id
          AND pv.status = 'ACTIVE'
         JOIN match_runs mr
           ON mr.workspace_id = c.workspace_id
          AND mr.id = c.latest_match_run_id
          AND mr.canonical_job_id = c.id
          AND mr.job_version_id = jv.id
          AND mr.profile_version_id = pv.id
          AND mr.requirement_set_id = jv.active_requirement_set_id
          AND mr.job_content_hash = jv.content_hash
          AND mr.context_fingerprint IS NOT NULL
          AND mr.status = 'COMPLETED'
         JOIN deterministic_decisions dd
           ON dd.workspace_id = c.workspace_id
          AND dd.id = c.latest_deterministic_decision_id
          AND dd.canonical_job_id = c.id
          AND dd.job_version_id = jv.id
          AND dd.match_run_id = mr.id
          AND dd.context_fingerprint = eq.context_fingerprint
         WHERE c.workspace_id = eq.workspace_id
           AND c.id = eq.canonical_job_id
           AND eq.job_version_id = jv.id
           AND eq.profile_version_id = pv.id
           AND eq.match_run_id = mr.id
           AND eq.deterministic_decision_id = dd.id
           AND eq.job_content_hash = jv.content_hash
         )
       )
     RETURNING eq.id`,
    params,
  );

  return rowCount ?? 0;
}
