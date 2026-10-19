import { z } from 'zod';

export const LANE_INTENT_SCHEMA_VERSION = '1.0.0';

export const SixLaneKeySchema = z.enum([
  'CORE_AI_DATA',
  'LEGAL_REGTECH',
  'UNIVERSITY_AI_RESEARCH',
  'HEALTH_BIO_PHARMA',
  'INVESTMENT_MARKETS_FINTECH',
  'SOCIAL_IMPACT_MULTILATERAL',
]);
export type SixLaneKey = z.infer<typeof SixLaneKeySchema>;

const RequiredLaneWeightsSchema = z.object({
  CORE_AI_DATA: z.number().min(0).max(100),
  LEGAL_REGTECH: z.number().min(0).max(100),
  UNIVERSITY_AI_RESEARCH: z.number().min(0).max(100),
  HEALTH_BIO_PHARMA: z.number().min(0).max(100),
  INVESTMENT_MARKETS_FINTECH: z.number().min(0).max(100),
  SOCIAL_IMPACT_MULTILATERAL: z.number().min(0).max(100),
}).superRefine((weights, context) => {
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  if (total !== 100) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Six-lane preference weights must total 100; received ${total}.`,
    });
  }
});

export const LanePreferenceTaxonomySchema = z.object({
  preferred_role_families: z.array(z.string()).default([]),
  acceptable_role_families: z.array(z.string()).default([]),
  excluded_role_families: z.array(z.string()).default([]),
  preferred_subdomains: z.array(z.string()).default([]),
  acceptable_subdomains: z.array(z.string()).default([]),
  excluded_subdomains: z.array(z.string()).default([]),
  preferred_organization_types: z.array(z.string()).default([]),
  acceptable_organization_types: z.array(z.string()).default([]),
  excluded_organization_types: z.array(z.string()).default([]),
});
export type LanePreferenceTaxonomy = z.infer<typeof LanePreferenceTaxonomySchema>;

export const CrossLaneWorkStyleSignalsSchema = z.object({
  positive: z.array(z.string()).default([]),
  negative: z.array(z.string()).default([]),
});
export type CrossLaneWorkStyleSignals = z.infer<typeof CrossLaneWorkStyleSignalsSchema>;

export const LaneIntentPreferencesSchema = z.object({
  schema_version: z.string().default(LANE_INTENT_SCHEMA_VERSION),
  lane_weights: RequiredLaneWeightsSchema,
  lane_preferences: z.record(SixLaneKeySchema, LanePreferenceTaxonomySchema).default({}),
  cross_lane_work_style_signals: CrossLaneWorkStyleSignalsSchema.default({}),
}).strict();
export type LaneIntentPreferences = z.infer<typeof LaneIntentPreferencesSchema>;

export const APPROVED_STAGE2_LANE_WEIGHTS: LaneIntentPreferences['lane_weights'] = {
  CORE_AI_DATA: 25,
  LEGAL_REGTECH: 20,
  UNIVERSITY_AI_RESEARCH: 20,
  HEALTH_BIO_PHARMA: 15,
  INVESTMENT_MARKETS_FINTECH: 15,
  SOCIAL_IMPACT_MULTILATERAL: 5,
};
