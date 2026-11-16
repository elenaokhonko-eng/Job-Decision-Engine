import type pg from "pg";

import type { MeasuredJobRow, SavedObservationRow } from "./rankingMeasurement.js";

/**
 * Read-only loaders for the ranking measurement tool. Every query is
 * workspace-scoped and the caller must hold a READ ONLY transaction.
 */

interface JobColumns {
  job_id: string | null;
  title: string | null;
  archived: boolean | null;
  processing_state: string | null;
  match_run_id: string | null;
  match_score: string | number | null;
  coverage_score: string | number | null;
  avg_similarity: string | number | null;
  decision_id: string | null;
  outcome: string | null;
  eligibility: string | null;
}

const toNumber = (value: string | number | null): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function toJobRow(row: JobColumns): MeasuredJobRow | null {
  const matchScore = toNumber(row.match_score);
  if (!row.job_id || row.match_run_id === null || matchScore === null) return null;
  return {
    jobId: row.job_id,
    title: row.title ?? "",
    matchScore,
    coverageScore: toNumber(row.coverage_score),
    avgSimilarity: toNumber(row.avg_similarity),
    outcome: row.outcome,
    eligibility: row.eligibility,
  };
}

const JOB_COLUMNS_SQL = `
    cj.id AS job_id,
    cj.normalized_title AS title,
    cj.processing_state AS processing_state,
    (cj.archived_at IS NOT NULL) AS archived,
    mr.id AS match_run_id,
    mr.overall_match_score AS match_score,
    mr.coverage_score AS coverage_score,
    (SELECT AVG(m.match_score) FROM requirement_evidence_matches m WHERE m.match_run_id = mr.id) AS avg_similarity,
    dd.id AS decision_id,
    dd.recommendation_outcome AS outcome,
    dd.recommendation_eligibility AS eligibility`;

const JOB_JOINS_SQL = `
  LEFT JOIN match_runs mr
    ON mr.id = cj.latest_match_run_id AND mr.status = 'COMPLETED'
  LEFT JOIN deterministic_decisions dd
    ON dd.id = cj.latest_deterministic_decision_id`;

export async function loadSavedObservations(
  client: pg.ClientBase,
  workspaceId: string,
  sourceName: string,
): Promise<SavedObservationRow[]> {
  const { rows } = await client.query<JobColumns & { observation_id: string }>(
    `
    SELECT o.id AS observation_id, ${JOB_COLUMNS_SQL}
    FROM raw_job_observations o
    LEFT JOIN job_versions jv ON jv.id = o.job_version_id
    LEFT JOIN canonical_jobs cj ON cj.id = jv.canonical_job_id AND cj.workspace_id = o.workspace_id
    ${JOB_JOINS_SQL}
    WHERE o.workspace_id = $1 AND o.source_name = $2
    ORDER BY o.id
    `,
    [workspaceId, sourceName],
  );
  return rows.map((row) => ({
    observationId: row.observation_id,
    jobId: row.job_id,
    jobArchived: row.archived === true,
    processingState: row.processing_state,
    hasCompletedMatch: row.match_run_id !== null,
    hasDecision: row.decision_id !== null,
    job: toJobRow(row),
  }));
}

export async function loadCandidateJobs(client: pg.ClientBase, workspaceId: string): Promise<MeasuredJobRow[]> {
  const { rows } = await client.query<JobColumns>(
    `
    SELECT ${JOB_COLUMNS_SQL}
    FROM canonical_jobs cj
    ${JOB_JOINS_SQL}
    WHERE cj.workspace_id = $1
      AND cj.archived_at IS NULL
      AND mr.id IS NOT NULL
      AND dd.id IS NOT NULL
    ORDER BY cj.id
    `,
    [workspaceId],
  );
  return rows.map(toJobRow).filter((row): row is MeasuredJobRow => row !== null);
}
