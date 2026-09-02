/**
 * Taxonomy concept contracts
 * @description Zod schemas for normalized skills, technologies, domains, functions
 * @version 2.0
 */

import { z } from 'zod';

// TODO: Phase 1-5 implementation
// Will include:
// - TaxonomyConceptSchema
// - ConceptRelationshipSchema
// - ProfileFactConceptSchema
// - JobRequirementConceptSchema

export const TaxonomyContractPlaceholder = z.object({
  schema_version: z.string(),
  note: z.literal('Taxonomy contracts to be implemented'),
});
