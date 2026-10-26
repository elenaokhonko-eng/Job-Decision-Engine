import { describe, expect, it } from "vitest";
import { DiscoveryScoutPlanner } from "../../ingestion/scouts/discoveryScouts.js";
import { REQUIRED_DISCOVERY_LANES } from "../../ingestion/discoveryPlanConfig.js";

describe("configured six-lane discovery plans", () => {
  it("loads all six lanes, target functions, and configured source keys without inventing employers", () => {
    const planner = new DiscoveryScoutPlanner();
    const targetCompanies = { CORE_AI_DATA: ["Configured Employer"] };
    const plans = planner.generateSearchPlans(targetCompanies);

    expect(Object.keys(plans).sort()).toEqual([...REQUIRED_DISCOVERY_LANES].sort());
    expect(plans.CORE_AI_DATA.targetCompanies).toEqual(["Configured Employer"]);
    expect(plans.SOCIAL_IMPACT_MULTILATERAL.targetCompanies).toEqual([]);
    expect(plans.UNIVERSITY_AI_RESEARCH.targetFeeds).toContain("himalayas");
    expect(plans.SOCIAL_IMPACT_MULTILATERAL.targetFeeds).toContain("we_work_remotely");
    expect(plans.UNIVERSITY_AI_RESEARCH.targetFunctions).toContain("research software engineer");
    expect(plans.INVESTMENT_MARKETS_FINTECH.targetKeywords).toContain("investment technology");
    expect(plans.UNIVERSITY_AI_RESEARCH.coverageNote).toContain("No institution-specific university ATS board");
    expect(plans.UNIVERSITY_AI_RESEARCH.searchQueries[0]).toContain("technical project manager");
  });
});
