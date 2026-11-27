/**
 * Reads for the review lists (src/modules/decision). Read only: posting records of earlier modules and their read-model
 * views.
 */
export interface DecisionQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface ReviewJobRow {
  id: string;
  company_name: string | null;
  title: string | null;
  location: string | null;
  canonical_url: string | null;
  workplace_type: string | null;
  processing_state: string | null;
  gate_decision: string | null;
  archived: boolean;
  test_fixture: boolean;
  content_complete: boolean;
  availability_state: string | null;
  description: string | null;
  identity_hashes: Array<string | null> | null;
}

/**
 * Every record that is not a test fixture, archived ones included (their postings must still be recognised), plus the
 * named records (rated before) whatever their state. An archived record carries no description.
 */
export async function selectReviewJobs(
  db: DecisionQueryable,
  workspaceId: string,
  alsoIds: readonly string[],
): Promise<ReviewJobRow[]> {
  const { rows } = await db.query(
    `SELECT job.id::text AS id, job.company_name, job.normalized_title AS title,
            COALESCE(NULLIF(BTRIM(job.location), ''), job.location_summary) AS location,
            job.canonical_url, job.workplace_type,
            COALESCE(job.processing_state, job.processing_status) AS processing_state,
            job.gate_decision,
            job.archived_at IS NOT NULL AS archived,
            job.is_test_fixture IS TRUE AS test_fixture,
            content.content_complete IS TRUE AS content_complete,
            availability.availability_state,
            CASE WHEN job.archived_at IS NULL THEN version.description_text END AS description,
            (SELECT ARRAY_AGG(any_version.source_posting_identity_hash) FROM job_versions any_version
              WHERE any_version.workspace_id = job.workspace_id AND any_version.canonical_job_id = job.id) AS identity_hashes
       FROM canonical_jobs job
       LEFT JOIN v_job_content_state content
         ON content.workspace_id = job.workspace_id AND content.canonical_job_id = job.id
       LEFT JOIN job_versions version
         ON version.workspace_id = job.workspace_id AND version.id = content.job_version_id
       LEFT JOIN v_job_availability_current availability
         ON availability.workspace_id = job.workspace_id AND availability.canonical_job_id = job.id
        AND availability.job_version_id::text = content.job_version_id::text
      WHERE job.workspace_id = $1::uuid
        AND (job.is_test_fixture IS NOT TRUE OR job.id::text = ANY($2::text[]))
      ORDER BY job.id`,
    [workspaceId, [...alsoIds]],
  );
  return rows as ReviewJobRow[];
}

export interface SightingRow {
  /** null for a saved export not linked to any canonical job. */
  job_id: string | null;
  source_name: string | null;
  source_url: string | null;
  canonical_apply_url: string | null;
  company_name: string | null;
  title: string | null;
  location_raw: string | null;
}

/** Every place a job was seen: observations of any version, their discovery parents, and source dispositions. */
export async function selectJobSightings(
  db: DecisionQueryable,
  workspaceId: string,
  savedSourceNames: readonly string[],
): Promise<SightingRow[]> {
  const { rows } = await db.query(
    `WITH RECURSIVE linked(job_id, observation_id) AS (
       (SELECT v.canonical_job_id, o.id
          FROM job_versions v JOIN raw_job_observations o ON o.job_version_id = v.id
         WHERE v.workspace_id = $1::uuid AND o.workspace_id = $1::uuid
        UNION
        SELECT d.canonical_job_id, d.job_observation_id FROM source_candidate_dispositions d
         WHERE d.workspace_id = $1::uuid AND d.canonical_job_id IS NOT NULL AND d.job_observation_id IS NOT NULL)
       UNION
       SELECT l.job_id, o.derived_from_observation_id
         FROM linked l JOIN raw_job_observations o ON o.id = l.observation_id
        WHERE o.workspace_id = $1::uuid AND o.derived_from_observation_id IS NOT NULL
     )
     SELECT l.job_id::text AS job_id, o.source_name, o.source_url, o.canonical_apply_url,
            o.company_name, o.title, o.location_raw
       FROM raw_job_observations o
       LEFT JOIN linked l ON l.observation_id = o.id
      WHERE o.workspace_id = $1::uuid AND (l.job_id IS NOT NULL OR UPPER(BTRIM(o.source_name)) = ANY($2::text[]))
     UNION ALL
     SELECT d.canonical_job_id::text, NULL, d.source_url, NULL, NULL, NULL, NULL
       FROM source_candidate_dispositions d
      WHERE d.workspace_id = $1::uuid AND d.canonical_job_id IS NOT NULL`,
    [workspaceId, [...savedSourceNames]],
  );
  return rows as SightingRow[];
}

export interface SimilarityRow {
  job_id: string;
  requirement_type: string;
  importance: string;
  match_type: string;
  semantic_score: number | null;
}

/**
 * The capability rows of each job's current completed match: those the matcher compared with a profile fact (it writes
 * the `semantic_score` key only on them), whatever score policy the run used.
 */
export async function selectMatchSimilarities(db: DecisionQueryable, workspaceId: string): Promise<SimilarityRow[]> {
  const { rows } = await db.query(
    `SELECT job.id::text AS job_id, requirement.requirement_type, requirement.importance, matched.match_type,
            (matched.evidence->>'semantic_score')::float8 AS semantic_score
       FROM canonical_jobs job
       JOIN match_runs run
         ON run.workspace_id = job.workspace_id AND run.id = job.latest_match_run_id
        AND run.status = 'COMPLETED' AND run.job_version_id = job.latest_job_version_id
       JOIN requirement_evidence_matches matched
         ON matched.workspace_id = job.workspace_id AND matched.match_run_id = run.id
       JOIN job_requirements requirement ON requirement.id = matched.requirement_id
      WHERE job.workspace_id = $1::uuid AND job.archived_at IS NULL
        AND jsonb_exists(matched.evidence, 'semantic_score')`,
    [workspaceId],
  );
  return rows as SimilarityRow[];
}
