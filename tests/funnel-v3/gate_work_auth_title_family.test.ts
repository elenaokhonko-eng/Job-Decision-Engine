import { describe, expect, it } from "vitest";
import { applyGlobalGates, nonTechnicalFunctionTitle } from "../../src/services/criteria.js";
import { applyPersistedRequirementGates } from "../../src/pipeline/hardGate.js";
import { assessHiringTerritoryReadiness } from "../../src/eligibility/workabilityReadiness.js";
import { DECIDER_VERSION } from "../../src/pipeline/deciderVersion.js";
import {
  evaluateWorkerTerritoryRequirements,
  loadWorkabilityPolicy,
  extractTerritories,
  isUnitedStatesOnlyLocation,
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
    "Must have: five years of backend work. Come and help us grow."],
  ["the pronoun us run into the requirement list", "Singapore",
    "You must know queues well Our values guide us when a decision is mandatory"],
  ["an upper-case heading JOIN US", "Singapore", "JOIN US and bring the required curiosity"],
  ["'invest in us' with a requirement word", "Singapore", "The trust our clients place in us is only earned slowly"],
  ["export-control licence boilerplate", "Singapore",
    "Where a task touches export-controlled material, we alone decide whether to seek a U.S. government licence, which some tasks require."],
  ["a fair-chance hiring notice", "Remote",
    "For Los Angeles residents: we consider applicants with conviction records, as the Fair Chance rules require."],
  ["an employer licence from a foreign central bank", "Singapore",
    "The firm trades within limits authorized by a bank in China."],
  ["an authorised-and-regulated statement", "Singapore",
    "Example Company is authorised and regulated by the financial regulator in the United Kingdom."],
  ["a commitment to learning a language", "Singapore", "English required, plus a commitment to learning French."],
  ["an export licence note", "Singapore",
    "A US export licence may be required for some tasks under export control rules."],
  ["an export licence application note", "Singapore",
    "Export laws may require us to obtain a US government licence before sharing technology."],
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

// A worker condition beside boilerplate, and wordings the pronoun rule does not recognise. All invented.
describe("boilerplate beside a real condition, and unrecognised wording, still reject", () => {
  it.each([
    // Export control beside a condition.
    "Our lab is export-controlled, so hiring is limited to people living in the US only",
    "Export-controlled tooling means every hire must be a US national",
    "The export-controlled platform team needs US work authorization, which is required",
    "Export controlled hardware: all staff must reside in the United States",
    "An export-controlled contract, open only to U.S. nationals",
    "Under ITAR export-controlled rules you must be a lawful US resident",
    "Export-controlled build: a US government licence is required and only US residents may apply",
    "Our export control rules mean every hire must reside in the United States",
    "Since export laws apply, hiring is limited to US residents only",
    "An export regulations review is routine, and US residency is mandatory",
    "Per our export control policy the team must be based in the US",
    "Export control duties mean each hire must be US persons",
    "Export control duties mean a US green card is mandatory",
    "Export control duties mean you must be a US national",
    "This export control role requires US work authorization",
    // Who may be hired, beside export wording or alone.
    "Export control duties: this post is open only to US persons",
    "Under export laws we can only take on US nationals",
    "Given export controls, hiring is limited to US persons",
    "Given export controls, the post is restricted to U.S. nationals",
    "This post is open to US persons because of export-controlled hardware",
    "Hiring for this post is limited to United States nationals",
    "We can hire only American citizens for this post",
    "This post is open to American citizens only",
    "Export control duties: we only hire American citizens",
    "This post requires US person status",
    "Export control duties mean the post requires U.S. person status",
    // Fair-chance and criminal-record wording beside a condition.
    "We hire under fair chance rules: US residents only",
    "Applicants must be US residents and clear a criminal record screen",
    "You must be US-based and clear a criminal records review",
    "A criminal history check applies and US work authorization is required",
    "Hiring is only open to people in the United States who clear a criminal history check",
    "US nationality required, with no criminal record",
    "US residency is mandatory; a criminal records review follows",
    "Los Angeles applicants only: fair chance rules apply",
    // "authorized by" an immigration authority or government.
    "Employment depends on being authorized by US immigration",
    "Only people authorized by the US government may hold this post",
    // Lower case and all capitals.
    "applicants must carry a valid us passport",
    "MUST CARRY US PASSPORT",
    "us permanent residency is required",
    "us employment visa sponsorship is required for nobody",
    "open to all us employees only",
    "a us green card is required",
    "you must have the right to work us wide",
    "only open to us.",
    // A U+0130 elsewhere must not switch off the capital-US reading.
    "Our \u0130stanbul team is hiring. You must carry a US passport",
  ])("rejects %j", (description) => {
    const result = gate(description);
    expect(result.status, JSON.stringify(result.rejection_codes)).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("WORK_AUTHORIZATION_INCOMPATIBLE");
  });

  it("still reads the pronoun when the posting holds a U+0130", () => {
    expect(territories("\u0130zmir hub. You must be curious and help us grow")).toEqual([]);
  });

  it("stays fast on a 200,000 character posting", () => {
    const inputs = [
      `You must ${"tell us ".repeat(25_000)}`,
      `must${" -".repeat(100_000)} us`,
      `must be here${" ".repeat(200_000)}us only`,
      "Come help us, as required. ".repeat(7_500),
      `${"export controlled fair chance records ".repeat(5_300)} us only`,
    ];
    for (const input of inputs) {
      expect(input.length).toBeGreaterThanOrEqual(195_000);
      const started = performance.now();
      extractExplicitWorkerTerritoryRequirements(input, { jobLocation: "Singapore", splitIgnoringCase: true });
      // The whole-prefix version of the pronoun check took several seconds on the first input.
      expect(performance.now() - started).toBeLessThan(2_500);
    }
  }, 60_000);
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

  it.each([
    "Our kiosk helps American citizens renew a library card",
    "We welcome not only American citizens but everyone",
    "The bursary is for Latin American citizens only",
    "This post does not require US person status",
    "The team studies how people obtain US person status",
  ])("reads no restriction in %j", (description) => {
    expect(territories(description)).toEqual([]);
    expect(gate(description).rejection_codes).not.toContain("WORK_AUTHORIZATION_INCOMPATIBLE");
  });

  it("does not make American a location name", () => {
    expect(extractTerritories("American Fork")).toEqual([]);
    expect(extractTerritories("American citizens only")).toEqual([]);
    expect(isUnitedStatesOnlyLocation("American Fork")).toBe(false);
  });

  it("does not read a negated limit as a restriction", () => {
    expect(territories("Hiring is not limited to US persons")).toEqual([]);
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

// The decider reads the same extractor through readiness, so its version moves with this change.
describe("decider readiness reads the same extractor", () => {
  const readiness = (description: string) => assessHiringTerritoryReadiness(description, null, "HYBRID", {
    authorizedRegions: ["SINGAPORE"],
    remoteWithoutTerritoryAllowed: true,
    rejectExplicitForeignTerritory: true,
    unknownWorkAuthorizationNeedsVerification: true,
  });

  it("does not block on the pronoun and never invents a pass", () => {
    expect(readiness(NO_RESTRICTION[0][2]).status).toBe("NEEDS_VERIFICATION");
  });

  it("still blocks a stated US-only residency", () => {
    expect(readiness("Candidates must reside in the US.").status).toBe("BLOCKED");
  });

  it("re-seeds decisions made by earlier decider versions", () => {
    expect(DECIDER_VERSION).toBe("recommendation_decider_v5");
  });
});

describe("a title family rejects only as the main role", () => {
  it.each([
    "Lead AI Engineer - DevOps & Mentoring",
    "Senior Full-Stack Developer & DevOps Lead",
    "Data Engineer (Site Reliability)",
    "Machine Learning Engineer, SRE collaboration",
    "AI Architect | DevOps and Delivery",
    "Data Engineer / DevOps Engineer",
    "Senior AI & Full-Stack Engineer, DevOps & Mentoring",
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
    // Owner decision: systems administration and customer success reject on the title.
    "Application Developer / Systems Administrator",
    "Data Analyst, Customer Success",
    "Product Manager - Customer Success",
    // A department is not a role, and a data centre is infrastructure.
    "Product Engineering - DevOps Engineer",
    "AI Engineering | DevOps Lead",
    "Product Engineering, QA Automation",
    "Data Engineering - Site Reliability Engineer",
    "Data Center Engineer - DevOps",
    "Data Centre Engineer (Network Security)",
    "Data Center Manager, Network Engineer",
    // Physical engineering names the domain of the work, wherever it appears.
    "Data Scientist - Quarry Bridge Studies, Civil Engineering",
  ])("still rejects %j", (title) => {
    expect(nonTechnicalFunctionTitle(title)).not.toBeNull();
    const result = gate("Build data pipelines in Python.", "Singapore", title);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toEqual(["NON_TARGET_ROLE_FAMILY", "GATE_OUT_OF_SCOPE_DOMAIN"]);
  });
});
