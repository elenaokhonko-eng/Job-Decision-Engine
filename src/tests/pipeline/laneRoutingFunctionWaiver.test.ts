import { describe, expect, it } from "vitest";

import {
  FUNCTION_WAIVER_MARGIN,
  hasApprovedLaneFunction,
  loadLanesConfig,
  routeLaneCandidates,
} from "../../pipeline/laneRouter.js";

const config = loadLanesConfig();

/** Every lane scores `base`; `overrides` set individual lanes. Fixtures are synthetic. */
function route(
  title: string,
  description: string,
  base: number,
  overrides: Record<string, number> = {},
  companyName = "Example Holdings",
) {
  return routeLaneCandidates({
    config,
    title,
    descriptionText: description,
    companyName,
    semanticScore: (laneKey) => overrides[laneKey] ?? base,
  });
}

// Asset-management and capital-markets work with no engineering, quantitative or data function
// phrase: the INVESTMENT_MARKETS_FINTECH domain is present and its function concept is absent.
const MARKETS_COORDINATION =
  "Coordinate the delivery of reporting for our asset management and capital markets business. " +
  "Run stakeholder meetings, track milestones and prepare status updates for senior management.";

describe("lane router function waiver (lane_router_v2.6.0)", () => {
  it("grants a lane at Low confidence when only the function score is zero and the semantic score is clearly above the bar", () => {
    const result = route("Delivery Coordination Lead", MARKETS_COORDINATION, 0.55);
    expect(result.processingStatus).toBe("LANE_ROUTED");
    expect(result.primaryLane).toBe("INVESTMENT_MARKETS_FINTECH");
    expect(result.laneConfidence).toBe("Low");
    expect(result.functionScores.INVESTMENT_MARKETS_FINTECH).toBe(0);
    expect(result.laneEvidence.some((e) => e.startsWith("INVESTMENT_MARKETS_FINTECH:function_waived;semantic_margin="))).toBe(true);
  });

  it("does not grant the lane when the semantic score is inside the margin", () => {
    const threshold = config.lanes.INVESTMENT_MARKETS_FINTECH.semantic_threshold ?? 0.35;
    const result = route("Delivery Coordination Lead", MARKETS_COORDINATION, 0.2, {
      INVESTMENT_MARKETS_FINTECH: threshold + FUNCTION_WAIVER_MARGIN - 0.01,
    });
    expect(result.processingStatus).toBe("UNMATCHED");
    expect(result.primaryLane).toBe("UNCLASSIFIED");
    // At the margin the lane is granted.
    const atMargin = route("Delivery Coordination Lead", MARKETS_COORDINATION, 0.2, {
      INVESTMENT_MARKETS_FINTECH: threshold + FUNCTION_WAIVER_MARGIN + 0.001,
    });
    expect(atMargin.primaryLane).toBe("INVESTMENT_MARKETS_FINTECH");
    expect(atMargin.laneConfidence).toBe("Low");
  });

  it("keeps the domain veto: no domain phrase, no lane, whatever the semantic score", () => {
    const result = route(
      "Delivery Coordination Lead",
      "Coordinate the delivery of internal reporting. Run stakeholder meetings and track milestones.",
      0.9,
    );
    expect(result.primaryLane).toBe("UNCLASSIFIED");
  });

  it("keeps the role-family veto", () => {
    const result = route("Sales Manager, Capital Markets Coordination", MARKETS_COORDINATION, 0.9);
    expect(result.primaryLane).toBe("UNCLASSIFIED");
  });

  it("keeps the cybersecurity veto", () => {
    const result = route(
      "Cyber Security Coordination Lead",
      `${MARKETS_COORDINATION} Own vulnerability management, threat detection and incident response for the security operations centre.`,
      0.9,
    );
    expect(result.primaryLane).toBe("UNCLASSIFIED");
  });

  it("keeps the negative-concept veto", () => {
    const negative = config.lanes.INVESTMENT_MARKETS_FINTECH.negative_concepts?.[0];
    if (!negative) return; // lane defines no negative concepts
    const result = route("Delivery Coordination Lead", `${MARKETS_COORDINATION} ${negative.replace(/_/g, " ")}.`, 0.9, {}, "Example Holdings");
    expect(result.primaryLane).not.toBe("INVESTMENT_MARKETS_FINTECH");
  });

  it("never waives the function of INVESTIGATIONS_ENFORCEMENT", () => {
    const result = route(
      "Programme Coordination Lead",
      "Coordinate reporting for the regulatory enforcement and financial crime function. Track milestones and prepare status updates.",
      0.2,
      { INVESTIGATIONS_ENFORCEMENT: 0.9 },
    );
    expect(result.primaryLane).not.toBe("INVESTIGATIONS_ENFORCEMENT");
  });

  it("lets a lane that qualifies outright win over a waived lane with a higher score, at normal confidence", () => {
    const result = route(
      "Product Manager",
      `Own the product roadmap for our digital platform and cloud platform. ${MARKETS_COORDINATION}`,
      0.2,
      { TECHNICAL_PRODUCT_TRANSFORMATION: 0.45, INVESTMENT_MARKETS_FINTECH: 0.8 },
    );
    expect(result.primaryLane).toBe("TECHNICAL_PRODUCT_TRANSFORMATION");
    expect(result.laneConfidence).not.toBe("Low");
    expect(result.laneEvidence.some((e) => e.includes("function_waived"))).toBe(false);
  });
});

describe("leadership words in the CORE_AI_DATA title list", () => {
  it.each(["Programme Director, Applied AI", "Head of Data Platform", "Lead, Applied Research Delivery", "Engineering Manager"])(
    "approves %s for CORE_AI_DATA",
    (title) => {
      expect(hasApprovedLaneFunction("CORE_AI_DATA", title)).toBe(true);
    },
  );

  it.each(["Sales Director", "Marketing Manager", "Talent Lead", "Operations Manager"])(
    "still refuses the non-technical role family %s",
    (title) => {
      expect(hasApprovedLaneFunction("CORE_AI_DATA", title)).toBe(false);
    },
  );
});
