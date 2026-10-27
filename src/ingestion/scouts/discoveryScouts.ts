/** Executable, manifest-backed Stage 0 plans; the planner never invents postings or employers. */
import { loadSixLaneSourcePlanConfig } from "../discoveryPlanConfig.js";

export interface ScoutSearchPlan {
  readonly lane: string;
  readonly planVersion: string;
  readonly targetKeywords: readonly string[];
  readonly domainTerms: readonly string[];
  readonly roleTerms: readonly string[];
  readonly targetFunctions: readonly string[];
  readonly targetCompanies: readonly string[];
  readonly targetFeeds: readonly string[];
  readonly searchQueries: readonly string[];
  readonly coverageNote: string;
  readonly plannedAt: string;
}

export class DiscoveryScoutPlanner {
  generateSearchPlans(
    targetCompaniesByLane: Readonly<Record<string, readonly string[]>> = {},
  ): Record<string, ScoutSearchPlan> {
    const config = loadSixLaneSourcePlanConfig();
    const plannedAt = new Date().toISOString();
    const plans: Record<string, ScoutSearchPlan> = {};

    for (const [lane, laneConfig] of Object.entries(config.lanes)) {
      const keywords = [...new Set([...laneConfig.domain_terms, ...laneConfig.role_terms])];
      const query = [...laneConfig.domain_terms, ...config.target_functions].join(" | ");
      plans[lane] = {
        lane,
        planVersion: config.plan_version,
        targetKeywords: keywords,
        domainTerms: laneConfig.domain_terms,
        roleTerms: laneConfig.role_terms,
        targetFunctions: config.target_functions,
        targetCompanies: targetCompaniesByLane[lane] ?? [],
        targetFeeds: laneConfig.source_keys,
        searchQueries: [query],
        coverageNote: laneConfig.coverage_note,
        plannedAt,
      };
    }
    return plans;
  }
}
