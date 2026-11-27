/** When each waiting job started to wait for a re-match: job_rematch_waits, owned by the decision module. */

export interface DecisionQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** Records the start for jobs found waiting without one. A recorded start is never moved. */
export async function insertNewRematchWaits(
  db: DecisionQueryable,
  workspaceId: string,
  canonicalJobIds: readonly string[] | null,
): Promise<void> {
  await db.query(
    `INSERT INTO job_rematch_waits (workspace_id, canonical_job_id)
     SELECT waiting.workspace_id, waiting.canonical_job_id
       FROM v_job_awaiting_rematch waiting
      WHERE waiting.workspace_id = $1::uuid AND waiting.waiting_since IS NULL
        AND ($2::uuid[] IS NULL OR waiting.canonical_job_id = ANY($2::uuid[]))
     ON CONFLICT (workspace_id, canonical_job_id) DO NOTHING`,
    [workspaceId, canonicalJobIds],
  );
}

/** Removes the start of jobs that no longer wait, so a later wait starts its own clock. */
export async function deleteEndedRematchWaits(
  db: DecisionQueryable,
  workspaceId: string,
  canonicalJobIds: readonly string[] | null,
): Promise<void> {
  await db.query(
    `DELETE FROM job_rematch_waits recorded
      WHERE recorded.workspace_id = $1::uuid
        AND ($2::uuid[] IS NULL OR recorded.canonical_job_id = ANY($2::uuid[]))
        AND NOT EXISTS (
          SELECT 1 FROM v_job_awaiting_rematch waiting
           WHERE waiting.workspace_id = recorded.workspace_id AND waiting.canonical_job_id = recorded.canonical_job_id)`,
    [workspaceId, canonicalJobIds],
  );
}
