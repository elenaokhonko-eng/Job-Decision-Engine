import pg from "pg";

export type JobArchiveState =
  | { readonly found: false }
  | { readonly found: true; readonly archivedAt: Date | string | null };

function stringField(value: unknown, key: string): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // Payload objects arrive from PostgreSQL JSONB and are narrowed at this boundary.
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() !== "" ? field.trim() : null;
}

function isUuid(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

const TRUSTED_SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

/**
 * SQL expression that reads a payload field as a UUID, or NULL when the value is
 * not a canonical lowercase UUID. Comparing `uuid_column = <this>` lets
 * PostgreSQL use primary-key lookups, while `uuid_column::text = payload->>...`
 * forces a scan per task. Only canonical lowercase text could ever equal
 * `uuid::text`, so this keeps the previous matching semantics exactly.
 */
export function pipelineTaskPayloadUuidSql(taskAlias: string, field: string): string {
  if (!TRUSTED_SQL_IDENTIFIER.test(taskAlias) || !TRUSTED_SQL_IDENTIFIER.test(field)) {
    throw new Error("Pipeline task payload SQL must use trusted identifiers.");
  }
  const value = `${taskAlias}.payload->>'${field}'`;
  return `(CASE WHEN ${value} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (${value})::uuid END)`;
}

/**
 * SQL predicate that is TRUE when a pipeline task row targets an archived
 * canonical job through its canonical job, job version, or source observation.
 * Each branch is a keyed lookup, so the cost per task is constant instead of
 * proportional to the number of archived jobs.
 */
export function pipelineTaskTargetsArchivedJobSql(taskAlias: string): string {
  if (!TRUSTED_SQL_IDENTIFIER.test(taskAlias)) {
    throw new Error("Pipeline task archive SQL must use a trusted alias.");
  }
  return `(
    EXISTS (
      SELECT 1
      FROM canonical_jobs archived_job
      WHERE archived_job.workspace_id = ${taskAlias}.workspace_id
        AND archived_job.id = ${pipelineTaskPayloadUuidSql(taskAlias, "canonical_job_id")}
        AND archived_job.archived_at IS NOT NULL
    )
    OR EXISTS (
      SELECT 1
      FROM job_versions archived_version
      JOIN canonical_jobs archived_job
        ON archived_job.workspace_id = archived_version.workspace_id
       AND archived_job.id = archived_version.canonical_job_id
      WHERE archived_version.workspace_id = ${taskAlias}.workspace_id
        AND archived_version.id = ${pipelineTaskPayloadUuidSql(taskAlias, "job_version_id")}
        AND archived_job.archived_at IS NOT NULL
    )
    OR EXISTS (
      SELECT 1
      FROM raw_job_observations archived_observation
      JOIN job_versions observation_version
        ON observation_version.workspace_id = archived_observation.workspace_id
       AND observation_version.id = archived_observation.job_version_id
      JOIN canonical_jobs archived_job
        ON archived_job.workspace_id = archived_observation.workspace_id
       AND archived_job.id = observation_version.canonical_job_id
      WHERE archived_observation.workspace_id = ${taskAlias}.workspace_id
        AND archived_observation.id = ${pipelineTaskPayloadUuidSql(taskAlias, "observation_id")}
        AND archived_job.archived_at IS NOT NULL
    )
  )`;
}

export async function loadJobArchiveState(
  client: pg.Pool | pg.PoolClient,
  workspaceId: string,
  canonicalJobId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<JobArchiveState> {
  const lockClause = options.forUpdate ? "FOR UPDATE" : "";
  const { rows } = await client.query<{ archived_at: Date | string | null }>(
    `SELECT archived_at
     FROM canonical_jobs
     WHERE workspace_id = $1 AND id = $2::uuid
     LIMIT 1 ${lockClause}`,
    [workspaceId, canonicalJobId],
  );
  const row = rows[0];
  return row ? { found: true, archivedAt: row.archived_at } : { found: false };
}

export async function archivedJobForPipelineTask(
  client: pg.Pool | pg.PoolClient,
  workspaceId: string,
  taskType: string,
  payload: unknown,
): Promise<{ readonly canonicalJobId: string; readonly archivedAt: Date | string } | null> {
  if (taskType === "NORMALIZE_OBSERVATION") return null;
  const canonicalJobId = stringField(payload, "canonical_job_id");
  const jobVersionId = stringField(payload, "job_version_id");
  const observationId = stringField(payload, "observation_id");
  const canonicalIdParam = isUuid(canonicalJobId) ? canonicalJobId : null;
  const versionIdParam = isUuid(jobVersionId) ? jobVersionId : null;
  const observationIdParam = isUuid(observationId) ? observationId : null;
  if (!canonicalIdParam && !versionIdParam && !observationIdParam) return null;

  // Resolve the target canonical job ids with keyed lookups first, then check
  // archive state. Probing every archived job with correlated subqueries made
  // this per-task guard cost grow with the size of the archive.
  const { rows } = await client.query<{
    canonical_job_id: string;
    archived_at: Date | string;
  }>(
    `WITH target AS (
       SELECT $2::uuid AS canonical_job_id
       WHERE $2::uuid IS NOT NULL
       UNION
       SELECT version.canonical_job_id
       FROM job_versions version
       WHERE version.workspace_id = $1
         AND version.id = $3::uuid
       UNION
       SELECT version.canonical_job_id
       FROM raw_job_observations observation
       JOIN job_versions version
         ON version.workspace_id = observation.workspace_id
        AND version.id = observation.job_version_id
       WHERE observation.workspace_id = $1
         AND observation.id = $4::uuid
     )
     SELECT canonical.id::text AS canonical_job_id, canonical.archived_at
     FROM target
     JOIN canonical_jobs canonical
       ON canonical.workspace_id = $1
      AND canonical.id = target.canonical_job_id
     WHERE canonical.archived_at IS NOT NULL
     LIMIT 1`,
    [workspaceId, canonicalIdParam, versionIdParam, observationIdParam],
  );
  const row = rows[0];
  return row ? { canonicalJobId: row.canonical_job_id, archivedAt: row.archived_at } : null;
}
