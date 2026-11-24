/**
 * Read-only: live, non-archived jobs whose ACTIVE requirement set has a requirement with no current
 * embedding_inputs row, counted by current recommendation outcome and processing state. Counts only,
 * no ids, titles or employers. Used to judge whether missing embeddings can change a replay result.
 */
import type pg from "pg";

type Queryable = Pick<pg.PoolClient, "query">;

export interface MissingInputReport {
  readonly jobs: number;
  readonly requirements: number;
  readonly byOutcome: Record<string, number>;
  readonly byState: Record<string, number>;
  readonly byOutcomeAndState: Record<string, number>;
}

export async function reportJobsMissingRequirementInputs(db: Queryable, workspaceId: string): Promise<MissingInputReport> {
  const { rows } = await db.query<{ outcome: string; state: string; jobs: string; requirements: string }>(
    `SELECT COALESCE(c.recommendation_outcome, 'NONE') AS outcome,
            COALESCE(c.processing_state, c.processing_status) AS state,
            COUNT(DISTINCT c.id)::text AS jobs,
            COUNT(r.id)::text AS requirements
       FROM canonical_jobs c
       JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
       JOIN job_requirements r ON r.workspace_id = jv.workspace_id AND r.requirement_set_id = jv.active_requirement_set_id
      WHERE c.workspace_id = $1::uuid AND c.archived_at IS NULL AND NOT c.is_test_fixture
        AND NOT EXISTS (
          SELECT 1 FROM embedding_inputs ei
           WHERE ei.workspace_id = r.workspace_id AND ei.source_type = 'JOB_REQUIREMENT' AND ei.source_id = r.id AND ei.is_current)
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    [workspaceId],
  );
  const total = await db.query<{ jobs: string }>(
    `SELECT COUNT(DISTINCT c.id)::text AS jobs
       FROM canonical_jobs c
       JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
       JOIN job_requirements r ON r.workspace_id = jv.workspace_id AND r.requirement_set_id = jv.active_requirement_set_id
      WHERE c.workspace_id = $1::uuid AND c.archived_at IS NULL AND NOT c.is_test_fixture
        AND NOT EXISTS (
          SELECT 1 FROM embedding_inputs ei
           WHERE ei.workspace_id = r.workspace_id AND ei.source_type = 'JOB_REQUIREMENT' AND ei.source_id = r.id AND ei.is_current)`,
    [workspaceId],
  );
  const byOutcome: Record<string, number> = {};
  const byState: Record<string, number> = {};
  const byOutcomeAndState: Record<string, number> = {};
  let requirements = 0;
  for (const row of rows) {
    // A job has one outcome and one state, so the per-group distinct counts add up exactly.
    byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + Number(row.jobs);
    byState[row.state] = (byState[row.state] ?? 0) + Number(row.jobs);
    byOutcomeAndState[`${row.outcome}/${row.state}`] = Number(row.jobs);
    requirements += Number(row.requirements);
  }
  return { jobs: Number(total.rows[0]?.jobs ?? 0), requirements, byOutcome, byState, byOutcomeAndState };
}
