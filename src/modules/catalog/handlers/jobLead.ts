import {
  selectJobVersionIsLead,
  selectLeadCanonicalJobIds,
  selectLeadCanonicalJobIdsFromDefinition,
  selectLeadReadModelAvailable,
  type CatalogQueryable,
} from "../../../platform/persistence/catalog/index.js";

/**
 * Job-board and aggregator leads: stored, never ranked, never queued for AI, never drawn for review. The definition
 * is the view v_job_lead_state (migration 123); code asks here and holds no host or source list of its own.
 *
 * Until migration 123 is applied there is no definition: nothing is treated as a lead (the behaviour before it) and
 * the process says so once.
 */
export const LEAD_READ_MODEL_MISSING_WARNING =
  "Lead read model v_job_lead_state is missing (migration 123 not applied): no job is treated as a lead.";

let warned = false;

export async function leadReadModelAvailable(db: CatalogQueryable): Promise<boolean> {
  const available = await selectLeadReadModelAvailable(db);
  if (!available && !warned) {
    warned = true;
    console.warn(LEAD_READ_MODEL_MISSING_WARNING);
  }
  return available;
}

/** What every refusal for a lead says, so it is never reported as a stale or missing artifact. */
export const JOB_IS_LEAD_REASON = "JOB_IS_LEAD";
export const JOB_IS_LEAD_MESSAGE =
  "This job is a lead: it is known only from job boards or aggregators, so it is not ranked, evaluated or prepared " +
  "for application until the employer's own posting or your saved copy of it is observed.";

export async function listLeadJobIds(db: CatalogQueryable, workspaceId: string): Promise<string[]> {
  if (!(await leadReadModelAvailable(db))) return [];
  return selectLeadCanonicalJobIds(db, workspaceId);
}

export interface LeadJobs {
  readonly ids: string[];
  /** The installed view, or the text of its migration when the view is not installed. */
  readonly source: "READ_MODEL" | "MIGRATION_TEXT";
}

/**
 * The leads for a read-only report on a database that may not have migration 123: never "no job is a lead" for want of
 * the view. `migrationSql` is the text of the lead definition migration.
 */
export async function listLeadJobsByDefinition(
  db: CatalogQueryable,
  workspaceId: string,
  migrationSql: string,
): Promise<LeadJobs> {
  if (await selectLeadReadModelAvailable(db)) {
    return { ids: await selectLeadCanonicalJobIds(db, workspaceId), source: "READ_MODEL" };
  }
  return { ids: await selectLeadCanonicalJobIdsFromDefinition(db, workspaceId, migrationSql), source: "MIGRATION_TEXT" };
}

export async function isLeadJobVersion(
  db: CatalogQueryable,
  workspaceId: string,
  jobVersionId: string,
): Promise<boolean> {
  if (!(await leadReadModelAvailable(db))) return false;
  return selectJobVersionIsLead(db, workspaceId, jobVersionId);
}
