/**
 * Read model contracts
 * @description Zod schemas for Streamlit and report consumers of canonical data
 * @version 2.0
 */

import { z } from 'zod';

// TODO: Phase 7 implementation
// Will include:
// - ShortlistRowV2Schema (updated with all new fields)
// - StreamlitJobDetailSchema
// - PipelineHealthSchema
// - DocumentStatusSchema

export const ReadModelContractPlaceholder = z.object({
  schema_version: z.string(),
  note: z.literal('Phase 7: Read model contracts to be implemented'),
});
