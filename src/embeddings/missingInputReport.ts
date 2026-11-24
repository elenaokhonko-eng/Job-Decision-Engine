/**
 * Read-only: live, non-archived jobs whose ACTIVE requirement set has a VALIDATED requirement that is not
 * embedded in the configured primary space (no current embedding input, or an input without a published
 * embedding in the active primary space). That is exactly what the PUBLISH_EMBEDDING seed and the embedding
 * builder can act on: only VALIDATED requirements are ever embedded. Counted by current recommendation
 * outcome and processing state. Counts only, no ids, titles or employers.
 */
import type pg from "pg";

import { getEmbeddingSpaceRegistryConfiguration } from "./spaceRegistry.js";

type Queryable = Pick<pg.PoolClient, "query">;

export interface MissingInputReport {
  readonly jobs: number;
  /** VALIDATED requirements of the active set that are not embedded in the primary space. */
  readonly requirements: number;
  /** The subset of `requirements` that has no current embedding input row at all. */
  readonly requirementsWithoutInput: number;
  readonly byOutcome: Record<string, number>;
  readonly byState: Record<string, number>;
  readonly byOutcomeAndState: Record<string, number>;
}

export async function reportJobsMissingRequirementInputs(db: Queryable, workspaceId: string): Promise<MissingInputReport> {
  const { primary } = getEmbeddingSpaceRegistryConfiguration();
  const { rows } = await db.query<{ outcome: string; state: string; jobs: string; requirements: string; without_input: string }>(
    `SELECT COALESCE(c.recommendation_outcome, 'NONE') AS outcome,
            COALESCE(c.processing_state, c.processing_status) AS state,
            COUNT(DISTINCT c.id)::text AS jobs,
            COUNT(r.id)::text AS requirements,
            COUNT(r.id) FILTER (WHERE NOT EXISTS (
              SELECT 1 FROM embedding_inputs any_input
               WHERE any_input.workspace_id = r.workspace_id AND any_input.source_type = 'JOB_REQUIREMENT'
                 AND any_input.source_id = r.id AND any_input.is_current))::text AS without_input
       FROM canonical_jobs c
       JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
       JOIN job_requirements r ON r.workspace_id = jv.workspace_id AND r.requirement_set_id = jv.active_requirement_set_id
      WHERE c.workspace_id = $1::uuid AND c.archived_at IS NULL AND c.is_test_fixture IS NOT TRUE
        AND jv.active_requirement_set_id IS NOT NULL
        AND r.status = 'VALIDATED'
        AND NOT EXISTS (
          SELECT 1 FROM embedding_inputs ei
           WHERE ei.workspace_id = r.workspace_id AND ei.source_type = 'JOB_REQUIREMENT' AND ei.source_id = r.id AND ei.is_current
             AND EXISTS (
               SELECT 1 FROM v_published_semantic_embeddings se
                 JOIN embedding_spaces sp ON sp.workspace_id = se.workspace_id AND sp.id = se.embedding_space_id
                WHERE se.workspace_id = ei.workspace_id AND se.embedding_input_id = ei.id
                  AND sp.active = TRUE AND sp.is_fallback_space = FALSE AND LOWER(sp.provider) = LOWER($2)
                  AND sp.model = $3 AND sp.dimensions = $4))
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    [workspaceId, primary.provider, primary.model, primary.dimensions],
  );
  const byOutcome: Record<string, number> = {};
  const byState: Record<string, number> = {};
  const byOutcomeAndState: Record<string, number> = {};
  let jobs = 0;
  let requirements = 0;
  let requirementsWithoutInput = 0;
  for (const row of rows) {
    // A job has one outcome and one state, so the per-group distinct counts add up exactly.
    const count = Number(row.jobs);
    byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + count;
    byState[row.state] = (byState[row.state] ?? 0) + count;
    byOutcomeAndState[`${row.outcome}/${row.state}`] = count;
    jobs += count;
    requirements += Number(row.requirements);
    requirementsWithoutInput += Number(row.without_input);
  }
  return { jobs, requirements, requirementsWithoutInput, byOutcome, byState, byOutcomeAndState };
}
