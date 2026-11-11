import { describe, expect, it } from "vitest";
import { applyGlobalGates, nonTechnicalFunctionTitle } from "../../services/criteria.js";
import { applyPersistedRequirementGates } from "../../pipeline/hardGate.js";

// Synthetic postings: each description mentions SQL/Python so the old keyword check passed them.
const TECHNICAL_SOUNDING = "Use SQL and Python dashboards daily. Work closely with the data platform team.";

// Since 2026-11 a non-technical function title is classification only, not a hard gate:
// a non-technical role is acceptable when it fits a lane and the candidate's experience,
// and lane routing decides (unrouted jobs end SKIP/UNCLASSIFIED).
describe("non-technical function titles are classified but not hard-rejected", () => {
  it.each([
    ["Senior GL Accountant", "GL Accountant"],
    ["Accountant", "Accountant"],
    ["Manager, Payroll Operations - APAC", "Payroll Operations"],
    ["Fund Operations Support Specialist", "Support Specialist"],
    ["Sr. UX Designer, Security", "UX Designer"],
    ["Marketplace Creative Strategist/Graphic Designer", "Graphic Designer"],
  ])("classifies %j and leaves it to lane routing", (title, matched) => {
    expect(nonTechnicalFunctionTitle(title)).toBe(matched);
    const persisted = applyPersistedRequirementGates({
      title,
      company_name: "Example Company",
      location: "Singapore",
      workplace_type: "HYBRID",
      employment_type: "FULL_TIME",
      description: TECHNICAL_SOUNDING,
    }, []);
    expect(persisted.status).toBe("PASS");
    expect(persisted.rejection_codes).not.toContain("NON_TECHNICAL_FUNCTION");

    const global = applyGlobalGates({
      id: `synthetic-${title}`,
      title,
      company_name: "Example Company",
      raw_description: TECHNICAL_SOUNDING,
      location: "Singapore",
      workplace_type: "HYBRID",
      employment_type: "PERMANENT",
    } as never);
    expect(global.status).not.toBe("HARD_REJECT");
    expect(global.rejection_codes).not.toContain("NON_TECHNICAL_FUNCTION");
  });

  it("keeps the separate non-target role-family exclusion (customer success)", () => {
    expect(nonTechnicalFunctionTitle("Customer Success Manager, Enterprise")).toBe("Customer Success");
    const result = applyPersistedRequirementGates({
      title: "Customer Success Manager, Enterprise",
      company_name: "Example Company",
      location: "Singapore",
      workplace_type: "HYBRID",
      employment_type: "FULL_TIME",
      description: TECHNICAL_SOUNDING,
    }, []);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toEqual(["NON_TARGET_ROLE_FAMILY", "GATE_OUT_OF_SCOPE_DOMAIN"]);
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
