import { describe, expect, it } from "vitest";
import { applyGlobalGates, nonTechnicalFunctionTitle, presalesTitle } from "../../services/criteria.js";
import { applyPersistedRequirementGates } from "../../pipeline/hardGate.js";

// Synthetic postings: each description mentions SQL/Python so the old keyword check passed them.
const TECHNICAL_SOUNDING = "Use SQL and Python dashboards daily. Work closely with the data platform team.";

function gates(title: string, description = TECHNICAL_SOUNDING) {
  const persisted = applyPersistedRequirementGates({
    title,
    company_name: "Example Company",
    location: "Singapore",
    workplace_type: "HYBRID",
    employment_type: "FULL_TIME",
    description,
  }, []);
  const global = applyGlobalGates({
    id: `synthetic-${title}`,
    title,
    company_name: "Example Company",
    raw_description: description,
    location: "Singapore",
    workplace_type: "HYBRID",
    employment_type: "PERMANENT",
  } as never);
  return { persisted, global };
}

// Non-target title families stay hard rejects with the role-family code. The generic
// technical-function check (Axis 1) is not a gate, so in-lane non-technical roles pass.
describe("non-target title families in the hard gates", () => {
  it.each([
    ["Senior GL Accountant", "GL Accountant"],
    ["Accountant", "Accountant"],
    ["Manager, Payroll Operations - APAC", "Payroll Operations"],
    ["Fund Operations Support Specialist", "Support Specialist"],
    ["Sr. UX Designer, Security", "UX Designer"],
    ["Marketplace Creative Strategist/Graphic Designer", "Graphic Designer"],
  ])("rejects %j as NON_TARGET_ROLE_FAMILY with the matched title as evidence", (title, matched) => {
    expect(nonTechnicalFunctionTitle(title)).toBe(matched);
    const { persisted, global } = gates(title);
    for (const result of [persisted, global]) {
      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toEqual(["NON_TARGET_ROLE_FAMILY", "GATE_OUT_OF_SCOPE_DOMAIN"]);
      expect(result.rejection_codes).not.toContain("NON_TECHNICAL_FUNCTION");
      expect(result.evidence_quotes.join(" ")).toContain(matched);
    }
    expect(persisted.evidence_quotes[0]).toBe(`Non-target title family "${matched}" in "${title}"`);
  });

  it("keeps the customer-success role-family exclusion", () => {
    const { persisted } = gates("Customer Success Manager, Enterprise");
    expect(persisted.status).toBe("HARD_REJECT");
    expect(persisted.rejection_codes).toEqual(["NON_TARGET_ROLE_FAMILY", "GATE_OUT_OF_SCOPE_DOMAIN"]);
  });

  it.each([
    "Lead Product Manager (Courts and Legal Services)",
    "Senior Product Manager, Data Programme",
    "Product Policy Manager / Lead",
    "Corporate Transformation Director",
    "Regulatory & Controls Program Manager - Banking",
    "Assistant Director, Enforcement (Investigator)",
    "Manager, Investigation Department",
    "Lead, Transformation Portfolio & Strategic Initiatives",
  ])("does not re-block the in-lane non-technical role %j", (title) => {
    expect(nonTechnicalFunctionTitle(title)).toBeNull();
    const { persisted, global } = gates(title, "Lead the programme with policy owners and stakeholders, and report outcomes to leadership.");
    for (const result of [persisted, global]) {
      expect(result.status, `${title}: ${JSON.stringify(result.rejection_codes)}`).toBe("PASS");
      expect(result.rejection_codes).toEqual([]);
    }
  });

  it.each([
    "Product Designer",
    "Payroll Platform Engineer",
    "Support Engineer, Data Platform",
    "Senior Data Analyst",
    "Specialist, Machine Learning Engineering",
  ])("does not match %j", (title) => {
    expect(nonTechnicalFunctionTitle(title)).toBeNull();
  });
});

// Owner policy (gate-2026-11.5): a pre-sales title is a high-interaction reject for any title,
// even when the description reads like an engineering role.
describe("pre-sales titles in the hard gates", () => {
  it.each([
    ["Presales Solutions Architect", "Presales"],
    ["Solutions Engineer (Pre-Sales), APAC", "Pre-Sales"],
    ["Pre Sales Consultant - AI Platform", "Pre Sales"],
    ["Senior Pre‑Sales Engineer", "Pre‑Sales"],
    ["AI Presale Architect", "Presale"],
  ])("rejects %j as GATE_HIGH_INTERACTION with the matched title as evidence", (title, matched) => {
    expect(presalesTitle(title)).toBe(matched);
    const { persisted, global } = gates(title, "Design and build data pipelines in Python and SQL for the analytics platform.");
    for (const result of [persisted, global]) {
      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toEqual(["GATE_HIGH_INTERACTION"]);
      expect(result.evidence_quotes[0]).toBe(`Pre-sales title "${matched}" in "${title}"`);
    }
  });

  it.each([
    "Pressure Systems Engineer",
    "Sales Operations Data Engineer",
    "Pre-trade Risk Engineer",
    "Senior Solutions Architect",
  ])("does not match %j", (title) => {
    expect(presalesTitle(title)).toBeNull();
  });
});
