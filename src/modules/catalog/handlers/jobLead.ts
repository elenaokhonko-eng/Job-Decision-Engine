import {
  selectJobVersionIsLead,
  selectLeadCanonicalJobIds,
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

export async function listLeadJobIds(db: CatalogQueryable, workspaceId: string): Promise<string[]> {
  if (!(await leadReadModelAvailable(db))) return [];
  return selectLeadCanonicalJobIds(db, workspaceId);
}

export async function isLeadJobVersion(
  db: CatalogQueryable,
  workspaceId: string,
  jobVersionId: string,
): Promise<boolean> {
  if (!(await leadReadModelAvailable(db))) return false;
  return selectJobVersionIsLead(db, workspaceId, jobVersionId);
}
