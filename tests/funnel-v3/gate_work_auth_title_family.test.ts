import { describe, expect, it } from "vitest";
import { applyGlobalGates, nonTechnicalFunctionTitle } from "../../src/services/criteria.js";
import { applyPersistedRequirementGates } from "../../src/pipeline/hardGate.js";
import {
  evaluateWorkerTerritoryRequirements,
  loadWorkabilityPolicy,
  extractExplicitWorkerTerritoryRequirements,
} from "../../src/pipeline/workabilityPolicy.js";

// gate-2026-11.9. All postings here are synthetic.

function gate(description: string, location = "Singapore", title = "Senior Data Engineer", workplaceType = "HYBRID", policy = loadWorkabilityPolicy()) {
  return applyGlobalGates({
    id: "synthetic",
    title,
    company_name: "Example Company",
    raw_description: description,
    location,
    workplace_type: workplaceType,
    employment_type: "PERMANENT",
  } as never, policy);
}

function persisted(quote: string) {
  return applyPersistedRequirementGates(
    { title: "Senior Data Engineer", company_name: "Example Company", location: "Singapore", workplace_type: "HYBRID", description: quote },
    [{ requirement_key: "work_auth_1", requirement_type: "WORK_AUTH", requirement_text: quote, quote_text: quote, structured_value: null }],
  );
}

const territories = (text: string) => extractExplicitWorkerTerritoryRequirements(text).flatMap((r) => r.territories);

const NO_RESTRICTION: Array<[string, string, string]> = [
  ["the pronoun us beside 'must have'", "Singapore",
    "Must have: eight years building distributed systems. We need forward-looking people to help us become a leading investor."],
  ["the pronoun us run into the requirement list", "Singapore",
    "You must have deep systems experience Join our teams, which guides us in how we make mandatory decisions"],
  ["an upper-case heading JOIN US", "Singapore", "JOIN US and bring the required curiosity"],
  ["'invest in us' with a requirement word", "Singapore", "The trust our clients place in us is only earned slowly"],
  ["export-control licence boilerplate", "Singapore",
    "Compliance: if access to export-controlled technology or source code is required for performance of job duties, it is within the employer's discretion whether to apply for a U.S. government license for such positions."],
  ["a fair-chance hiring notice", "Remote",
    "Unincorporated LA County residents: qualified applicants with arrest or conviction records will be considered for employment in accordance with the Los Angeles County Fair Chance Ordinance."],
  ["an employer licence from a foreign central bank", "Singapore",
    "The company manages a part of the reserves within the scope authorized by the central bank of China and undertakes investment business."],
  ["an authorised-and-regulated statement", "Singapore",
    "Example Company is authorised and regulated by the financial regulator in the United Kingdom."],
  ["a commitment to learning a language", "Singapore", "English required, plus a commitment to learning French."],
];

describe("sentences that state no worker-territory restriction", () => {
  it.each(NO_RESTRICTION)("does not reject on %s", (_name, location, description) => {
    expect(territories(description)).toEqual([]);
    const result = gate(description, location, "Senior Data Engineer", location === "Remote" ? "REMOTE" : "HYBRID");
    expect(result.rejection_codes).not.toContain("WORK_AUTHORIZATION_INCOMPATIBLE");
    expect(result.status).not.toBe("HARD_REJECT");
    expect(result.workability_facts.location_restriction).toBeNull();
  });

  it.each(NO_RESTRICTION)("stores no restriction from a persisted quote with %s", (_name, _location, description) => {
    const result = persisted(description);
    expect(result.status).not.toBe("HARD_REJECT");
    expect(result.workability_facts.location_restriction).toBeNull();
  });

  it("keeps an unknown remote territory as NEEDS_VERIFICATION, not a rejection or a pass", () => {
    const result = gate(NO_RESTRICTION[5][2], "Remote", "Senior Data Engineer", "REMOTE",
      { ...loadWorkabilityPolicy(), unknownWorkAuthorizationNeedsVerification: true });
    expect(result.status).toBe("NEEDS_VERIFICATION");
    expect(result.rejection_codes).toContain("NEEDS_VERIFICATION_HIRING_TERRITORY");
  });
});

describe("stated restrictions still reject", () => {
  it.each([
    "Candidates must be located in the US.",
    "Applicants must reside in the U.S. We offer flexible hours.",
    "Must be a US citizen.",
    "US citizens only.",
    "us residents only",
    "You must be legally authorized to work in the United States.",
    "Must have US work authorization.",
    "Only open to US applicants.",
    "Candidates must hold a valid US passport.",
    "This role is remote (US only).",
    "Join us. You must be authorized to work in the US.",
    "Requires an active U.S. Government security clearance.",
    "Because of export-controlled technology, applicants must be US persons.",
    "Export control rules require that you are a U.S. citizen or permanent resident.",
    "Applicants with conviction records are considered, but you must be authorized to work in the US.",
  ])("rejects %j", (description) => {
    const result = gate(description);
    expect(result.status, JSON.stringify(result.rejection_codes)).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("WORK_AUTHORIZATION_INCOMPATIBLE");
    expect(result.workability_facts.location_restriction).toBe("UNITED_STATES");
  });

  it("rejects a persisted US-only residency quote", () => {
    const result = persisted("Candidates must reside in the US.");
    expect(result.status).toBe("HARD_REJECT");
    expect(result.workability_facts.location_restriction).toBe("UNITED_STATES");
  });

  it("keeps the pronoun from joining a second country to a stated one", () => {
    const requirements = extractExplicitWorkerTerritoryRequirements("Tell us you are authorized to work in Singapore");
    expect(requirements.map((r) => r.territories)).toEqual([["SINGAPORE"]]);
    expect(evaluateWorkerTerritoryRequirements(requirements, ["SINGAPORE"]).status).toBe("ALLOWED");
  });

  it("quotes the posting's own words, pronoun included", () => {
    const [requirement] = extractExplicitWorkerTerritoryRequirements("Tell us you must reside in Germany");
    expect(requirement.evidenceText).toBe("Tell us you must reside in Germany");
  });
});

describe("a title family rejects only as the main role", () => {
  it.each([
    "Lead AI Engineer - DevOps & Mentoring",
    "Senior Full-Stack Developer & DevOps Lead",
    "Data Engineer (Site Reliability)",
    "Machine Learning Engineer, SRE collaboration",
    "AI Architect | DevOps and Delivery",
  ])("does not reject %j", (title) => {
    expect(nonTechnicalFunctionTitle(title)).toBeNull();
    const result = gate("Build data pipelines in Python.", "Singapore", title);
    expect(result.rejection_codes).not.toContain("NON_TARGET_ROLE_FAMILY");
  });

  it.each([
    "DevOps Engineer",
    "Senior DevOps Engineer - AI Platform",
    "DevOps & AI Engineer",
    "Cloud DevOps Engineer, Data Platform",
    "Senior Engineer - DevOps",
    "Software Engineer (DevOps)",
    "AVP, Site Reliability Engineer",
    "Technology Group - DevOps Lead",
    "Infrastructure Engineer / DevOps",
    "AI Security Engineer",
    "Software Engineer, Test Automation",
    // Physical engineering names the domain of the work, wherever it appears.
    "AI Scientist - Domain Expert, Crashworthiness",
  ])("still rejects %j", (title) => {
    expect(nonTechnicalFunctionTitle(title)).not.toBeNull();
    const result = gate("Build data pipelines in Python.", "Singapore", title);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toEqual(["NON_TARGET_ROLE_FAMILY", "GATE_OUT_OF_SCOPE_DOMAIN"]);
  });
});
