import pg from "pg";

export async function isCurrentCanonicalJobVersion(
  client: pg.Pool | pg.PoolClient,
  workspaceId: string,
  canonicalJobId: string,
  jobVersionId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ is_current: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM job_versions version
       JOIN canonical_jobs job
         ON job.workspace_id = version.workspace_id
        AND job.id = version.canonical_job_id
       WHERE version.workspace_id = $1
         AND job.id = $2
         AND version.id = $3
         AND job.latest_job_version_id = version.id
     ) AS is_current`,
    [workspaceId, canonicalJobId, jobVersionId],
  );
  return Boolean(rows[0]?.is_current);
}
