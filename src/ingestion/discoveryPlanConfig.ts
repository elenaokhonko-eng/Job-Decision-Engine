import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { z } from "zod";

export const REQUIRED_DISCOVERY_LANES = [
  "CORE_AI_DATA",
  "LEGAL_REGTECH",
  "HEALTH_BIO_PHARMA",
  "INVESTMENT_MARKETS_FINTECH",
  "SOCIAL_IMPACT_MULTILATERAL",
  "UNIVERSITY_AI_RESEARCH",
] as const;

const SourcePlanLaneSchema = z.object({
  domain_terms: z.array(z.string().min(1)).min(1),
  role_terms: z.array(z.string().min(1)).min(1),
  source_keys: z.array(z.string().regex(/^[a-z][a-z0-9_]{2,63}$/)).min(1),
  coverage_note: z.string().min(1),
});

export const SixLaneSourcePlanConfigSchema = z.object({
  schema_version: z.string().min(1),
  plan_version: z.string().min(1),
  target_functions: z.array(z.string().min(1)).min(1),
  lanes: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/), SourcePlanLaneSchema),
}).superRefine((config, context) => {
  for (const lane of REQUIRED_DISCOVERY_LANES) {
    if (!config.lanes[lane]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lanes", lane],
        message: `Required discovery lane ${lane} has no configured source plan.`,
      });
    }
  }
});

export type SixLaneSourcePlanConfig = z.infer<typeof SixLaneSourcePlanConfigSchema>;

export function loadSixLaneSourcePlanConfig(filePath = path.resolve(process.cwd(), "config/source-plans/six_lane_sources.yml")): SixLaneSourcePlanConfig {
  const contents = fs.readFileSync(filePath, "utf8");
  const parsed: unknown = load(contents);
  return SixLaneSourcePlanConfigSchema.parse(parsed);
}
