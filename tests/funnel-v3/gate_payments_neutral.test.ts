/**
 * gate-2026-11.11: payments is neutral (owner decision 2026-11-27). A title about payments no
 * longer rejects a job, at the gate or in the discovery pre-screen, and is not preferred.
 * All titles and posting text here are invented.
 */
import { describe, expect, it } from "vitest";

import { GATE_VERSION } from "../../src/contracts/version.js";
import { assessCandidateLanes } from "../../src/ingestion/discoveryPlanExecution.js";
import { PRESCREEN_TIER1_DEFAULTS } from "../../src/ingestion/discoveryPrescreen.js";
import { DiscoveryScoutPlanner } from "../../src/ingestion/scouts/discoveryScouts.js";
import { loadGlobalLanesConfig } from "../../src/pipeline/laneConfigLoader.js";
import { applyGlobalGates } from "../../src/services/criteria.js";

const DUTIES =
  "You will design data pipelines, build services in TypeScript and Python, review code and own the data platform architecture.";

const gate = (title: string) =>
  applyGlobalGates(
    {
      id: "synthetic",
      title,
      company_name: "Example Ledger Co",
      source: "canonical",
      location: "Singapore",
      workplace_type: "HYBRID",
      raw_description: DUTIES,
    } as any,
  );

const PAYMENTS_TITLES = [
  "Data Engineer, Payments",
  "Platform Architect - Merchant Acquiring",
  "Software Engineer (Remittance)",
  "Data Architect, Card Issuing",
  "Backend Engineer, Credit Card Platform",
  "Software Engineer, POS Terminals",
  "Data Engineer, BNPL",
  "Data Engineer, Buy Now Pay Later",
];

describe("payments titles are neutral at the gate", () => {
  it("carries the new gate version", () => {
    expect(GATE_VERSION).toBe("gate-2026-11.11");
  });

  it.each(PAYMENTS_TITLES)("does not reject: %s", (title) => {
    const result = gate(title);
    expect(result.status).not.toBe("HARD_REJECT");
    expect(result.rejection_codes).not.toContain("GATE_OUT_OF_SCOPE_DOMAIN");
  });

  it("gives a payments title the same result as the title without the word", () => {
    expect(gate("Data Engineer, Payments")).toEqual(gate("Data Engineer, Ledgers"));
  });

  it("leaves the consumer-lending title rule in place", () => {
    const result = gate("Data Engineer, Consumer Lending");
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toEqual(["GATE_OUT_OF_SCOPE_DOMAIN"]);
  });
});

describe("payments titles are neutral in the discovery pre-screen", () => {
  const lanes = loadGlobalLanesConfig().lanes;
  const plans = new DiscoveryScoutPlanner().generateSearchPlans();
  const tier1 = { ...PRESCREEN_TIER1_DEFAULTS, roleInTitleOnly: false };
  const assess = (title: string) =>
    assessCandidateLanes(
      {
        company_name: "Example Ledger Co",
        title,
        description_raw: "A software architect role on a fintech platform with market data and risk analytics.",
        location_raw: "Singapore",
        workplace_type_raw: "HYBRID",
      },
      ["INVESTMENT_MARKETS_FINTECH"], plans, lanes, [], tier1,
    )[0];

  it.each([
    "Software Architect, Payments",
    "Software Architect, Card Payments",
    "Software Architect, Merchant Acquiring",
    "Software Architect, Remittance",
    "Software Architect, BNPL",
  ])("does not exclude: %s", (title) => {
    expect(assess(title)).toMatchObject({ matched: true, reasonCode: "LANE_MATCHED" });
  });

  it("still excludes the other listed concepts", () => {
    expect(assess("Software Architect, Consumer Lending")).toMatchObject({ reasonCode: "LANE_EXCLUDED_DOMAIN" });
    expect(assess("Software Architect, Treasury")).toMatchObject({ reasonCode: "LANE_EXCLUDED_DOMAIN" });
  });

  it("does not make payments a preference", () => {
    const lane = lanes.INVESTMENT_MARKETS_FINTECH;
    for (const list of [lane.keywords, lane.positive_concepts]) {
      expect((list ?? []).join(" | ")).not.toMatch(/payment|remittance|merchant|bnpl|card/i);
    }
  });
});
