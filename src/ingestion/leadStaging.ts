import type pg from "pg";

export const AGGREGATOR_LEAD_ERROR =
  "AGGREGATOR_LEAD: an aggregator alert is a lead; it needs the employer's own posting or a saved-jobs export before it can become a job.";

/**
 * Marks just-staged aggregator lead observations FETCH_BLOCKED with an error-history entry. Runs inside the
 * alert's staging transaction; throws when the row count differs so the whole alert rolls back and stays
 * unprocessed (nothing is lost, the Gmail message is kept).
 */
export async function blockLeadObservations(
  client: pg.PoolClient,
  workspaceId: string,
  observationIds: readonly string[],
  now: Date = new Date(),
): Promise<void> {
  const ids = [...new Set(observationIds)];
  if (ids.length === 0) return;
  const blocked = await client.query(
    `UPDATE raw_job_observations
        SET processing_status = 'FETCH_BLOCKED',
            error_history = COALESCE(error_history, '[]'::jsonb) || jsonb_build_array($3::jsonb)
      WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
    [workspaceId, ids, JSON.stringify({
      stage: "FETCH_JOB_CONTENT",
      processing_status: "FETCH_BLOCKED",
      error: AGGREGATOR_LEAD_ERROR,
      occurred_at: now.toISOString(),
    })],
  );
  if ((blocked.rowCount ?? 0) !== ids.length) {
    throw new Error(`Gmail discovery marked ${blocked.rowCount ?? 0} of ${ids.length} lead observations FETCH_BLOCKED.`);
  }
}
