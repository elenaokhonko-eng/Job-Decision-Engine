import { z } from 'zod';

export const LaneConceptSetSchema = z
  .object({
    any: z.array(z.string()).optional(),
  })
  .passthrough();

export const LaneScopeSchema = z
  .object({
    required_function_concepts: LaneConceptSetSchema.optional(),
    included_domain_concepts: LaneConceptSetSchema.optional(),
    excluded_domain_concepts: LaneConceptSetSchema.optional(),
  })
  .passthrough();

export const LanePrototypeSchema = z
  .object({
    prototype_key: z.string().min(1).max(200),
    text: z.string().min(1),
    weight: z.number().min(0).max(1).optional(),
  })
  .passthrough();

export const LaneRoutingSchema = z
  .object({
    minimum_domain_score: z.number().min(0).max(1).optional(),
    minimum_function_score: z.number().min(0).max(1).optional(),
    minimum_semantic_score: z.number().min(0).max(1).optional(),
    secondary_lane_threshold: z.number().min(0).max(1).optional(),
  })
  .passthrough();

export const LaneSourcingSchema = z
  .object({
    enabled_sources: z.array(z.string()).optional(),
    query_sets: z.array(z.string()).optional(),
  })
  .passthrough();

export const LaneBudgetSchema = z
  .object({
    maximum_ai_interpretations_per_run: z.number().int().min(0).optional(),
  })
  .passthrough();

export const LaneFileConfigSchema = z
  .object({
    schema_version: z.string().optional(),
    lane_key: z.string().min(1).max(200),
    display_name: z.string().min(1).max(200),
    description: z.string().min(1).max(4000),
    scope: LaneScopeSchema.optional(),
    prototypes: z.array(LanePrototypeSchema).optional(),
    routing: LaneRoutingSchema.optional(),
    sourcing: LaneSourcingSchema.optional(),
    budget: LaneBudgetSchema.optional(),
    positive_concepts: z.array(z.string()).optional(),
    negative_concepts: z.array(z.string()).optional(),
    semantic_threshold: z.number().min(0).max(1).optional(),
  })
  .passthrough();

export type LaneFileConfig = z.infer<typeof LaneFileConfigSchema>;

