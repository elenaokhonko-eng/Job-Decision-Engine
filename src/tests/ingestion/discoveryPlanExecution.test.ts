import { describe, expect, it } from "vitest";
import { loadGlobalLanesConfig } from "../../pipeline/laneConfigLoader.js";
import { loadSixLaneSourcePlanConfig } from "../../ingestion/discoveryPlanConfig.js";
import { DiscoveryScoutPlanner } from "../../ingestion/scouts/discoveryScouts.js";
import { assessCandidateLanes } from "../../ingestion/discoveryPlanExecution.js";

describe("six-lane source plan matching", () => {
  it("retains a technical project manager without requiring the literal word management", () => {
    const lanesConfig = loadGlobalLanesConfig();
    const sourceConfig = loadSixLaneSourcePlanConfig();
    const plans = new DiscoveryScoutPlanner().generateSearchPlans();
    const result = assessCandidateLanes({
      company_name: "Acme",
      title: "Technical Project Manager",
      description_raw: "Deliver an AI data platform with software engineering teams.",
      location_raw: "Singapore",
      workplace_type_raw: "HYBRID",
    }, ["CORE_AI_DATA"], plans, lanesConfig.lanes);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ laneKey: "CORE_AI_DATA", matched: true, reasonCode: "LANE_MATCHED" });
    expect(sourceConfig.plan_version).toBe("six_lane_sources_v1");
  });

  it("keeps domain and target function as separate tests and reports the precise filter reason", () => {
    const lanesConfig = loadGlobalLanesConfig();
    const plans = new DiscoveryScoutPlanner().generateSearchPlans();
    const noFunction = assessCandidateLanes({
      company_name: "Acme",
      title: "Research Finance Analyst",
      description_raw: "Investment technology and market data organization.",
      location_raw: "Remote",
      workplace_type_raw: "REMOTE",
    }, ["INVESTMENT_MARKETS_FINTECH"], plans, lanesConfig.lanes);
    const noDomain = assessCandidateLanes({
      company_name: "Acme",
      title: "Technical Project Manager",
      description_raw: "Build internal HR and facilities workflow software.",
      location_raw: "Singapore",
      workplace_type_raw: "HYBRID",
    }, ["INVESTMENT_MARKETS_FINTECH"], plans, lanesConfig.lanes);

    expect(noFunction[0]).toMatchObject({ matched: false, reasonCode: "TARGET_FUNCTION_MISS" });
    expect(noDomain[0]).toMatchObject({ matched: false, reasonCode: "LANE_DOMAIN_MISS" });
  });

  it("does not let the investment lane source pure quantitative or traditional finance roles without technical ownership", () => {
    const lanesConfig = loadGlobalLanesConfig();
    const plans = new DiscoveryScoutPlanner().generateSearchPlans();
    const result = assessCandidateLanes({
      company_name: "Investment Firm",
      title: "Quantitative Researcher",
      description_raw: "Develop statistical strategies for public markets and investment portfolios.",
      location_raw: "Singapore",
      workplace_type_raw: "HYBRID",
    }, ["INVESTMENT_MARKETS_FINTECH"], plans, lanesConfig.lanes);

    expect(result[0]).toMatchObject({ matched: false, reasonCode: "TARGET_FUNCTION_MISS" });
  });

  it("uses an explicitly configured employer lane as domain provenance, not a display-name guess", () => {
    const lanesConfig = loadGlobalLanesConfig();
    const plans = new DiscoveryScoutPlanner().generateSearchPlans();
    const result = assessCandidateLanes({
      company_name: "Configured Employer",
      title: "Technical Delivery Lead",
      description_raw: "Lead architecture and delivery for the employer's product platform.",
      location_raw: "Singapore",
      workplace_type_raw: "HYBRID",
    }, ["CORE_AI_DATA"], plans, lanesConfig.lanes, ["CORE_AI_DATA"]);

    expect(result[0].matched).toBe(true);
  });
});
