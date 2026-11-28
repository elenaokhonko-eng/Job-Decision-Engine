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

/** The two views of migration 123 that state the definition, in dependency order. */
const LEAD_DEFINITION_VIEWS = ["v_job_lead_rules", "v_job_lead_state"] as const;

/**
 * The same read for a database without migration 123: the view bodies are taken from the migration's own text and run
 * as common table expressions, so no host or source rule is written here. Nothing is created.
 */
export async function selectLeadCanonicalJobIdsFromDefinition(
  db: CatalogQueryable,
  workspaceId: string,
  migrationSql: string,
): Promise<string[]> {
  const expressions = LEAD_DEFINITION_VIEWS.map((view) => {
    // A view statement ends at the first semicolon that closes a line and is followed by a blank line or the end.
    const body = new RegExp(`^CREATE OR REPLACE VIEW ${view} AS\\r?\\n([\\s\\S]*?);[ \\t]*\\r?\\n(?:\\r?$|(?![\\s\\S]))`, "m")
      .exec(migrationSql)?.[1];
    if (!body) throw new Error(`Refusing to read leads: ${view} was not found in the lead definition migration.`);
    return `${view} AS (\n${body}\n)`;
  });
  const { rows } = await db.query(
    `WITH ${expressions.join(",\n")}
     SELECT lead.canonical_job_id::text AS id
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
