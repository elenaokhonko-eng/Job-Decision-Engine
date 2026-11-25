/**
 * gate-2026-11.7 (owner decision 2026-11-25, decision #213): GATE_HIGH_INTERACTION hard-rejects only on explicit
 * evidence. One bare phrase with no workability fact never rejects; a customer-engagement duty phrase lowers the rank
 * through the existing role-shape signal CUSTOMER_FACING_DELIVERY.
 *
 * Synthetic postings only: every employer and sentence below is written for this test.
 */
import { describe, expect, it } from "vitest";
import { evaluateHardGatesForJob, remoteTerritoryScopeForPolicy } from "../../src/pipeline/hardGate.js";
import { findExplicitSalesDuty } from "../../src/pipeline/customerFacingDuties.js";
import { assessRoleShape, ROLE_SHAPE_POLICY_VERSION } from "../../src/pipeline/roleShape.js";
import { loadWorkabilityPolicy } from "../../src/pipeline/workabilityPolicy.js";

const policy = loadWorkabilityPolicy();

function gate(title: string, description: string) {
  return evaluateHardGatesForJob({
    job: {
      title,
      company_name: "Fernquill Legal Systems",
      description,
      location: "Singapore",
      workplace_type: "HYBRID",
      employment_type: "PERMANENT",
      compensation_raw: null,
    },
    requirements: [],
    profileFacts: [],
    policy,
    stage3Preferences: {},
    territoryScope: remoteTerritoryScopeForPolicy(policy),
  });
}

const BASE = "<p>Design and build contract-analysis workflows with Python and LLM APIs for legal teams.</p>";

const BARE_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["(a) customer-journey duty", "<ul><li>Own the customer journey for our contract-review solution.</li></ul>"],
  ["(a) face of the company", "<ul><li>Serve as the face of Fernquill to enterprise legal teams.</li></ul>"],
  ["(b) experience requirement", "<p>Experience in sales engineering or solutions consulting is a plus.</p>"],
  ["(c) works with the pre-sales team", "<p>You will work with our pre-sales team on technical questions.</p>"],
  ["(c) supports pre-sales", "<p>You will support pre-sales and contract negotiation activities.</p>"],
];

describe("GATE_HIGH_INTERACTION needs explicit evidence", () => {
  it.each(BARE_PHRASES)("a single bare phrase does not hard-reject: %s", (_label, body) => {
    const result = gate("Legal Solutions Lead", `${BASE}${body}`);
    expect(result.rejection_codes).not.toContain("GATE_HIGH_INTERACTION");
    expect(result.status).not.toBe("HARD_REJECT");
  });

  it("a duty phrase downranks through CUSTOMER_FACING_DELIVERY and keeps the quote as the label", () => {
    const description = `${BASE}
Own the customer journey for our contract-review solution.`;
    const shape = assessRoleShape({ title: "Legal Solutions Lead", description });
    expect(ROLE_SHAPE_POLICY_VERSION).toBe("role_shape_v2");
    expect(shape.signals).toHaveLength(1);
    expect(shape.signals[0]).toMatchObject({ code: "CUSTOMER_FACING_DELIVERY", penalty: 0.06, source: "DESCRIPTION" });
    expect(shape.signals[0]!.quote.toLowerCase()).toContain("customer journey");
    expect(shape.total_penalty).toBe(0.06);
  });

  it("text without any customer-engagement phrase has no signal", () => {
    expect(assessRoleShape({ title: "Legal Engineer", description: BASE }).signals).toEqual([]);
  });

  it.each([
    ["a quota", "<p>You will carry a quarterly sales quota for new logos.</p>"],
    ["commission-based pay", "<p>This is a commission-based position with uncapped upside.</p>"],
    ["cold outbound as a duty", "<ul><li>Cold calling and outbound prospecting to build pipeline.</li></ul>"],
  ])("explicit evidence still hard-rejects: %s", (_label, body) => {
    const result = gate("Legal Solutions Lead", `${BASE}${body}`);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
    expect(result.evidence_quotes[0]).toMatch(/^Explicit sales-target duty: "/);
  });

  it("a pre-sales title still hard-rejects", () => {
    const result = gate("Presales Solutions Engineer", BASE);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
  });

  it("a negated or hedged explicit phrase does not reject", () => {
    expect(findExplicitSalesDuty("this role does not carry a sales quota.")).toBeNull();
    expect(findExplicitSalesDuty("you may occasionally join cold calling sessions.")).toBeNull();
    expect(findExplicitSalesDuty("our securities commission clients value accuracy.")).toBeNull();
  });
});
