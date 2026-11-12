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
    required_sector_concepts: LaneConceptSetSchema.optional(),
    /** Domain concepts that waive the excluded-sector rule (a genuine AI/data role in any sector). */
    sector_exempt_domain_concepts: LaneConceptSetSchema.optional(),
    /** Sectors no lane covers: a job there does not route to this lane unless sector-exempt. */
    excluded_sector_concepts: LaneConceptSetSchema.optional(),
    /** Covered sectors that cancel an excluded-sector match (a bank's retail banking unit). */
    excluded_sector_override_concepts: LaneConceptSetSchema.optional(),
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
    minimum_domain_signals: z.number().int().min(1).max(10).optional(),
    /**
     * Where the required sector may be found. JOB_SCOPE (default): the job's own scope, plus the
     * employer context only when the title names technology work. JOB_SCOPE_OR_EMPLOYER: the
     * job's own scope or the employer's self-description (company name, opening, About Us).
     */
    sector_evidence: z.enum(['JOB_SCOPE', 'JOB_SCOPE_OR_EMPLOYER']).optional(),
    /**
     * Distinct sector-exempt domain phrases in the job's scope needed to waive the excluded-sector rule
     * (default 1); one sector-exempt phrase in the title always waives it.
     */
    sector_exempt_minimum_signals: z.number().int().min(1).max(10).optional(),
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

