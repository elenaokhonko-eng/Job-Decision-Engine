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

  const { rows } = await client.query<{
    canonical_job_id: string;
    archived_at: Date | string;
  }>(
    `SELECT canonical.id::text AS canonical_job_id, canonical.archived_at
     FROM canonical_jobs canonical
     WHERE canonical.workspace_id = $1
       AND canonical.archived_at IS NOT NULL
       AND (
         canonical.id = $2::uuid
         OR EXISTS (
           SELECT 1
           FROM job_versions version
           WHERE version.workspace_id = canonical.workspace_id
             AND version.canonical_job_id = canonical.id
             AND version.id = $3::uuid
         )
         OR EXISTS (
           SELECT 1
           FROM raw_job_observations observation
           JOIN job_versions version
             ON version.workspace_id = observation.workspace_id
            AND version.id = observation.job_version_id
           WHERE observation.workspace_id = canonical.workspace_id
             AND observation.id = $4::uuid
             AND version.canonical_job_id = canonical.id
         )
       )
     LIMIT 1`,
    [workspaceId, canonicalIdParam, versionIdParam, observationIdParam],
  );
  const row = rows[0];
  return row ? { canonicalJobId: row.canonical_job_id, archivedAt: row.archived_at } : null;
}
