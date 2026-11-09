import { describe, expect, it } from "vitest";
import { applyGlobalGates, nonTechnicalFunctionTitle } from "../../services/criteria.js";
import { applyPersistedRequirementGates } from "../../pipeline/hardGate.js";

// Synthetic postings: each description mentions SQL/Python so the old keyword check passed them.
const TECHNICAL_SOUNDING = "Use SQL and Python dashboards daily. Work closely with the data platform team.";

describe("non-technical function titles in the hard gates", () => {
  it.each([
    ["Customer Success Manager, Enterprise", "Customer Success"],
    ["Senior GL Accountant", "GL Accountant"],
    ["Accountant", "Accountant"],
    ["Manager, Payroll Operations - APAC", "Payroll Operations"],
    ["Fund Operations Support Specialist", "Support Specialist"],
    ["Sr. UX Designer, Security", "UX Designer"],
    ["Marketplace Creative Strategist/Graphic Designer", "Graphic Designer"],
  ])("rejects %j as NON_TECHNICAL_FUNCTION with the matched title as evidence", (title, matched) => {
    expect(nonTechnicalFunctionTitle(title)).toBe(matched);
    const persisted = applyPersistedRequirementGates({
      title,
      company_name: "Example Company",
      location: "Singapore",
      workplace_type: "HYBRID",
      employment_type: "FULL_TIME",
      description: TECHNICAL_SOUNDING,
    }, []);
    expect(persisted.status).toBe("HARD_REJECT");
    expect(persisted.rejection_codes).toEqual(expect.arrayContaining(["GATE_OUT_OF_SCOPE_DOMAIN"]));
    expect(persisted.rejection_codes.some((code) => code === "NON_TECHNICAL_FUNCTION" || code === "NON_TARGET_ROLE_FAMILY")).toBe(true);
    expect(persisted.evidence_quotes.join(" ")).toContain(title);

    const global = applyGlobalGates({
      id: `synthetic-${title}`,
      title,
      company_name: "Example Company",
      raw_description: TECHNICAL_SOUNDING,
      location: "Singapore",
      workplace_type: "HYBRID",
      employment_type: "PERMANENT",
    } as never);
    expect(global.status).toBe("HARD_REJECT");
  });

  it("names NON_TECHNICAL_FUNCTION for a title the older exclusions did not cover", () => {
    const result = applyPersistedRequirementGates({
      title: "Senior GL Accountant",
      company_name: "Example Company",
      location: "Singapore",
      workplace_type: "HYBRID",
      employment_type: "FULL_TIME",
      description: TECHNICAL_SOUNDING,
    }, []);
    expect(result.rejection_codes).toEqual(["NON_TECHNICAL_FUNCTION", "GATE_OUT_OF_SCOPE_DOMAIN"]);
    expect(result.evidence_quotes[0]).toBe('Non-technical function title "GL Accountant" in "Senior GL Accountant"');
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
