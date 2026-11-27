/** Public file of the catalog module: the only file other code may import. */
export {
  JOB_IS_LEAD_MESSAGE,
  JOB_IS_LEAD_REASON,
  LEAD_READ_MODEL_MISSING_WARNING,
  isLeadJobVersion,
  leadReadModelAvailable,
  listLeadJobIds,
} from "./handlers/jobLead.js";
export { normalizeJobIdentity, type JobIdentityNames } from "./domain/jobIdentity.js";
