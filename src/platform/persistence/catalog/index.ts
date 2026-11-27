/** Reads of the lead read model (migration 123). Read only: v_job_lead_state is the one definition of a lead. */
export interface CatalogQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export async function selectLeadReadModelAvailable(db: CatalogQueryable): Promise<boolean> {
  const { rows } = await db.query("SELECT to_regclass('v_job_lead_state') IS NOT NULL AS available");
  return rows[0]?.available === true;
}

export async function selectLeadCanonicalJobIds(db: CatalogQueryable, workspaceId: string): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT lead.canonical_job_id::text AS id
       FROM v_job_lead_state lead
      WHERE lead.workspace_id = $1::uuid AND lead.is_lead`,
    [workspaceId],
  );
  return rows.map((row) => String(row.id));
}

export async function selectJobVersionIsLead(
  db: CatalogQueryable,
  workspaceId: string,
  jobVersionId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT lead.is_lead
       FROM job_versions version
       JOIN v_job_lead_state lead
         ON lead.workspace_id = version.workspace_id AND lead.canonical_job_id = version.canonical_job_id
      WHERE version.workspace_id = $1::uuid AND version.id = $2::uuid`,
    [workspaceId, jobVersionId],
  );
  return rows[0]?.is_lead === true;
}
