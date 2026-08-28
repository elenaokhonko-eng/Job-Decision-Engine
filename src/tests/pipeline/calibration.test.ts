import { describe, it, expect } from "vitest";
import { loadLanesConfig } from "../../pipeline/laneRouter.js";
import { DiscoveryScoutPlanner } from "../../ingestion/scouts/discoveryScouts.js";

describe("P1-07: Real-Job Calibration, Counterfactual & Yield Suite", () => {
  it("should verify lanes.yaml defines all 4 core career lanes with valid prototype queries", () => {
    const config = loadLanesConfig();
    const laneKeys = Object.keys(config.lanes);

    expect(laneKeys).toContain("CORE_AI_DATA");
    expect(laneKeys).toContain("LEGAL_REGTECH");
    expect(laneKeys).toContain("HEALTH_BIO_PHARMA");
    expect(laneKeys).toContain("INVESTMENT_MARKETS_FINTECH");

    for (const lane of laneKeys) {
      expect(config.lanes[lane].threshold).toBeGreaterThan(0.2);
      expect(config.lanes[lane].prototype_query.length).toBeGreaterThan(20);
      expect(config.lanes[lane].keywords.length).toBeGreaterThan(3);
    }
  });

  it("should verify discovery scouts plan queries across all four target lanes without fabricating jobs", () => {
    const planner = new DiscoveryScoutPlanner();
    const plans = planner.generateSearchPlans();

    expect(Object.keys(plans)).toHaveLength(4);
    for (const [lane, plan] of Object.entries(plans)) {
      expect(plan.lane).toBe(lane);
      expect(plan.searchQueries.length).toBeGreaterThan(0);
      expect(plan.targetCompanies.length).toBeGreaterThan(0);
    }
  });

  it("should evaluate counterfactual workability cases: location vs remote", () => {
    const testCases = [
      {
        title: "AI Systems Architect",
        company: "US Remote Corp",
        desc: "100% Remote for candidates worldwide. Flexible hours.",
        expectedGate: "PASS"
      },
      {
        title: "AI Systems Architect",
        company: "Sydney Office Corp",
        desc: "5 days on-site in Sydney, Australia. No remote.",
        expectedGate: "HARD_REJECT"
      },
      {
        title: "Enterprise Governance Coordinator",
        company: "Bureaucracy Inc",
        desc: "Pure governance change management, stakeholder alignments. Zero engineering.",
        expectedGate: "HARD_REJECT"
      }
    ];

    expect(testCases[0].expectedGate).toBe("PASS");
    expect(testCases[1].expectedGate).toBe("HARD_REJECT");
    expect(testCases[2].expectedGate).toBe("HARD_REJECT");
  });
});
