/**
 * Audited Requeue Path for Manual-Review Evaluations
 *
 * Provides safe, audited recovery for jobs in NEEDS_MANUAL_REVIEW caused by
 * optional culture evidence quote mismatches.
 *
 * Invariant: Thresholds are never lowered.
 */

import type pg from "pg";

export interface RequeueCandidateRow {
  queue_id: string;
  canonical_job_id: string;
  job_version_id: string;
  company_name: string;
  normalized_title: string;
  last_error: string | null;
  attempt_count: number;
  max_attempts: number;
}

export interface RequeueResult {
  dryRun: boolean;
  candidatesFound: number;
  requeuedCount: number;
  candidates: Array<{
    queueId: string;
    canonicalJobId: string;
    jobVersionId: string;
    companyName: string;
    title: string;
    lastError: string | null;
  }>;
}

export async function findCultureQuoteManualReviewCandidates(
  client: pg.PoolClient | pg.Pool,
  workspaceId: string
): Promise<RequeueCandidateRow[]> {
  const { rows } = await client.query<RequeueCandidateRow>(
    `SELECT
       eq.id AS queue_id,
       eq.canonical_job_id,
       eq.job_version_id,
       c.company_name,
       c.normalized_title,
       eq.last_error,
       eq.attempt_count,
       eq.max_attempts
     FROM evaluation_queue eq
     JOIN canonical_jobs c
       ON c.id = eq.canonical_job_id
      AND c.workspace_id = eq.workspace_id
     WHERE eq.workspace_id = $1
       AND eq.status = 'NEEDS_MANUAL_REVIEW'
       AND (
         eq.last_error ILIKE '%culture evidence quote%'
         OR eq.last_error ILIKE '%not a verbatim substring%'
       )
     ORDER BY eq.priority_score DESC, eq.enqueued_at ASC`,
    [workspaceId]
  );
  return rows;
}

export async function requeueManualReviewEvaluations(
  client: pg.PoolClient,
  workspaceId: string,
  options: { dryRun?: boolean; queueIds?: string[] } = {}
): Promise<RequeueResult> {
  const dryRun = options.dryRun !== false; // Default to dry-run for safety unless explicitly false
  const allCandidates = await findCultureQuoteManualReviewCandidates(client, workspaceId);

  const selectedCandidates = options.queueIds && options.queueIds.length > 0
    ? allCandidates.filter((c) => options.queueIds!.includes(c.queue_id))
    : allCandidates;

  const result: RequeueResult = {
    dryRun,
    candidatesFound: selectedCandidates.length,
    requeuedCount: 0,
    candidates: selectedCandidates.map((c) => ({
      queueId: c.queue_id,
      canonicalJobId: c.canonical_job_id,
      jobVersionId: c.job_version_id,
      companyName: c.company_name,
      title: c.normalized_title,
      lastError: c.last_error,
    })),
  };

  if (dryRun || selectedCandidates.length === 0) {
    return result;
  }

  // Execute audited requeue in the transaction
  for (const candidate of selectedCandidates) {
    // 1. Reset evaluation_queue item to PENDING with reset attempt count
    await client.query(
      `UPDATE evaluation_queue
       SET status = 'PENDING',
           attempt_count = 0,
           lease_id = NULL,
           lease_expires_at = NULL,
           available_at = NOW(),
           last_error = 'Audited requeue: unsupported optional culture quote safely unmeasured; thresholds preserved',
           updated_at = NOW()
       WHERE workspace_id = $1
         AND id = $2
         AND status = 'NEEDS_MANUAL_REVIEW'`,
      [workspaceId, candidate.queue_id]
    );

    // 2. Insert audited attempt entry
    await client.query(
      `INSERT INTO evaluation_attempts (
         workspace_id,
         canonical_job_id,
         job_version_id,
         attempt_number,
         provider,
         model,
         status,
         error_message,
         latency_ms
       ) VALUES ($1, $2, $3, $4, 'system-audit', 'requeue-culture-quote-fix', 'REQUEUED', $5, NULL)`,
      [
        workspaceId,
        candidate.canonical_job_id,
        candidate.job_version_id,
        candidate.attempt_count + 1,
        'Audited requeue: culture quote verbatim error resolved without lowering thresholds',
      ]
    );

    // 3. Update canonical_jobs processing state back to QUEUED_FOR_AI
    await client.query(
      `UPDATE canonical_jobs
       SET processing_state = 'QUEUED_FOR_AI',
           processing_status = 'QUEUED_FOR_AI',
           rejection_reason = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1
         AND id = $2
         AND COALESCE(processing_state, processing_status) = 'NEEDS_MANUAL_REVIEW'`,
      [workspaceId, candidate.canonical_job_id]
    );

    result.requeuedCount += 1;
  }

  return result;
}
