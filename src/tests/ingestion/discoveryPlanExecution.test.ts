import { describe, expect, it } from "vitest";
import { assessCandidateLanes } from "../../ingestion/discoveryPlanExecution.js";
import { DiscoveryScoutPlanner } from "../../ingestion/scouts/discoveryScouts.js";
import { loadGlobalLanesConfig } from "../../pipeline/laneConfigLoader.js";

describe("discovery lane matching", () => {
  it("matches a singular solution architect title against the configured solutions architect function", () => {
    const plans = new DiscoveryScoutPlanner().generateSearchPlans();
    const result = assessCandidateLanes({
      company_name: "SMBC",
      title: "Director, AI Solution Architect",
      description_raw: "Enterprise AI architecture, agentic AI, RAG, and financial services integration.",
      location_raw: "Singapore",
      workplace_type_raw: "UNKNOWN",
    }, ["CORE_AI_DATA", "INVESTMENT_MARKETS_FINTECH"], plans, loadGlobalLanesConfig().lanes);

    expect(result.find((lane) => lane.laneKey === "CORE_AI_DATA")?.matched).toBe(true);
    expect(result.find((lane) => lane.laneKey === "INVESTMENT_MARKETS_FINTECH")?.matched).toBe(false);
  });
});
