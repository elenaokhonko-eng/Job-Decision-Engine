/**
 * Lane definition contracts
 * @description Zod schemas for career lane configuration and routing
 * @version 2.0
 */

import { z } from 'zod';

export const LaneKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{2,63}$/);

// TODO: Phase 4 implementation
// Will include:
// - LaneDefinitionSchema
// - LanePrototypeSchema
// - LaneRoutingPolicySchema
// - CandidateLanePreferenceSchema

export const LaneContractPlaceholder = z.object({
  schema_version: z.string(),
  lane_key: LaneKeySchema,
  note: z.literal('Phase 4: Lane configuration contracts to be implemented'),
});
