/**
 * Government citizenship and security-clearance requirements (gate-2026-11.2).
 *
 * Synthetic postings only: employer names are invented and descriptions model the
 * shape of real postings. The authorized region is Singapore (config default).
 */
import { describe, expect, it } from "vitest";
import { applyGlobalGates } from "../../src/services/criteria.js";
import { evaluateHardGatesForJob, remoteTerritoryScopeForPolicy } from "../../src/pipeline/hardGate.js";
import {
  evaluateWorkerTerritoryRequirements,
  extractExplicitWorkerTerritoryRequirements,
  extractGovernmentEligibilityRequirements,
  loadWorkabilityPolicy,
} from "../../src/pipeline/workabilityPolicy.js";
import { GATE_VERSION } from "../../src/contracts/version.js";
import { TERRITORY_FIXTURES, type GatePolicyFixture } from "./fixtures/g_gate_policy_2026_11.fixtures.js";

const policy = loadWorkabilityPolicy();
const DUTIES = "Design Salesforce data models and integrations for a health records modernization program.";

function status(text: string) {
  return evaluateWorkerTerritoryRequirements(extractExplicitWorkerTerritoryRequirements(text), ["SINGAPORE"]).status;
}

function gate(location: string, workplaceType: string, description: string) {
  return applyGlobalGates({
    id: "synthetic",
    title: "Solutions Architect",
    company_name: "Synthetic Federal Systems",
    location,
    workplace_type: workplaceType,
    employment_type: "PERMANENT",
    raw_description: description,
  } as any, policy);
}

/** The shape of the reported posting: HTML list items, the "U." lost from "U.S.". */
const TRUNCATED_US_POSTING = [
  "<h3>Salesforce Solutions Architect</h3><h3>Remote</h3>",
  `<p>${DUTIES}</p>`,
  "<h3>Security Requirements</h3><ul>",
  "<li>Experience supporting federal healthcare or health IT initiatives.</li>",
  "<li>Must be able to obtain and maintain any required federal background investigation or VA clearance.</li>",
  "<li>S. Citizenship required.</li>",
  "</ul><p><em>**Disclaimer: This position is contingent upon receipt of contract award and Government acceptance of the proposed candidate.**</em></p>",
].join("");

describe("explicit foreign citizenship requirements", () => {
  it.each([
    "U.S. Citizenship required.",
    "US citizenship is required for this role.",
    "Must be a US citizen.",
    "Candidates must be U.S. citizens.",
    "Applicants must be a U.S. person as defined by ITAR.",
    "Due to U.S. export control regulations, applicants must be U.S. citizens.",
  ])("rejects %s", (text) => {
    expect(status(text.toLowerCase())).toBe("INCOMPATIBLE");
  });

  it("reads a truncated 'S. Citizenship required' as U.S. only with U.S. federal context nearby", () => {
    expect(status("Supports federal health programs.\nS. Citizenship required.")).toBe("INCOMPATIBLE");
    expect(status("Must pass a VA clearance.\nS. Citizenship required.")).toBe("INCOMPATIBLE");
    expect(status("S. Citizenship required.")).toBe("ALLOWED");
    expect(status("Build dashboards for retail clients.\nS. Citizenship required.")).toBe("ALLOWED");
    expect(status("Supports federal health programs.\nS. Citizenship preferred.")).toBe("ALLOWED");
  });

  it("quotes the truncated line and its U.S. context as evidence", () => {
    const [requirement] = extractGovernmentEligibilityRequirements("Supports federal health programs.\nS. Citizenship required.");
    expect(requirement?.territories).toEqual(["UNITED_STATES"]);
    expect(requirement?.evidenceText).toMatch(/^S\. Citizenship required\..*federal health programs/);
  });
});

describe("government security clearance requirements", () => {
  it.each([
    ["Must be able to obtain and maintain any required federal background investigation or VA clearance.", "UNITED_STATES"],
    ["Ability to obtain and maintain a Public Trust clearance.", "UNITED_STATES"],
    ["Active TS/SCI clearance with polygraph required.", "UNITED_STATES"],
    ["Active DoD Secret security clearance.", "UNITED_STATES"],
    ["Must hold an active Secret clearance.\nSupports Department of Defense mission systems.", "UNITED_STATES"],
    ["Must hold current SC clearance.", "UNITED_KINGDOM"],
    ["Must hold NV1 security clearance.", "AUSTRALIA"],
  ])("rejects %s as a %s government requirement", (text, government) => {
    const requirements = extractGovernmentEligibilityRequirements(text.toLowerCase());
    expect(requirements.map((r) => r.territories[0])).toContain(government);
    expect(status(text.toLowerCase())).toBe("INCOMPATIBLE");
  });

  it.each([
    "Must be able to pass a Singapore government security clearance.",
    "Active Secret security clearance required.",
    "Security clearance preferred but not required. Supports federal clients.",
    "No security clearance is required. Supports federal clients.",
    "Responsible for customs clearance of medical devices.",
    "A pre-employment background check is required.",
    "Individual salaries are determined by factors such as location, client contract requirements, education, experience and security clearances. Supports federal clients.",
    "As a condition of employment, candidates may be required to provide information to determine whether any export license, governmental authorization, security clearance or other approval is required.",
  ])("does not reject %s", (text) => {
    expect(status(text.toLowerCase())).toBe("ALLOWED");
  });
});

describe("US-based remote roles", () => {
  it("treats a remote, US-based role as a worker-territory restriction", () => {
    expect(status("this is a remote, us-based role.")).toBe("INCOMPATIBLE");
    expect(status("we are hiring us-based candidates only.")).toBe("INCOMPATIBLE");
  });

  it("does not treat employer, pay or benefit mentions of US-based as a restriction", () => {
    expect(status("we are a us-based company with clients worldwide.")).toBe("ALLOWED");
    expect(status("we provide u.s.-based employees with a comprehensive benefits package.")).toBe("ALLOWED");
    expect(status("for this us-based position, the base pay range is $100,000 to $120,000.")).toBe("ALLOWED");
  });

  it.each(["United States (Remote)", "Remote - US", "Remote, United States"])(
    "rejects a remote job located in the US (%s) as a location mismatch when no Singapore/APAC eligibility is stated",
    (location) => {
      const result = gate(location, "REMOTE", `${DUTIES} Fully remote role.`);
      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("GATE_JOB_LOCATION_MISMATCH");
    },
  );
});

describe("end to end through the hard gate", () => {
  it("hard-rejects the truncated-citizenship federal posting with quoted evidence", () => {
    const result = evaluateHardGatesForJob({
      job: {
        title: "Salesforce Solutions Architect",
        company_name: "Synthetic Federal Systems",
        description: TRUNCATED_US_POSTING,
        location: "Remote",
        workplace_type: "REMOTE",
        employment_type: "CONTRACT",
        compensation_raw: null,
      },
      requirements: [],
      profileFacts: [],
      policy,
      stage3Preferences: {},
      territoryScope: remoteTerritoryScopeForPolicy(policy),
    });
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("WORK_AUTHORIZATION_INCOMPATIBLE");
    expect(result.workability_facts.location_restriction).toBe("UNITED_STATES");
    const evidence = result.evidence_quotes.join(" ");
    expect(evidence).toMatch(/s\. citizenship required/i);
    expect(evidence).toMatch(/federal background investigation or va clearance/i);
  });

  it("still passes the same posting when the security section is absent", () => {
    const result = gate("Remote", "REMOTE", `<h3>Remote</h3><p>${DUTIES}</p>`);
    expect(result.status).toBe("PASS");
  });

  it("bumps the gate version so stored decisions are re-gated", () => {
    expect(GATE_VERSION).toBe("gate-2026-11.2");
  });
});

describe("#173 territory false positives stay fixed", () => {
  it.each(Object.values(TERRITORY_FIXTURES) as GatePolicyFixture[])("$id: $notes", (fixture) => {
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      employment_type: "PERMANENT",
      raw_description: fixture.raw_description,
    } as any, policy);
    expect(result.status).toBe(fixture.expectedStatus);
    for (const code of fixture.forbiddenCodes ?? []) expect(result.rejection_codes).not.toContain(code);
  });

  it("keeps Southeast Asia/APAC lists, HQ mentions and ITAR licence conditions allowed", () => {
    expect(status("candidates must be based in southeast asia.")).toBe("ALLOWED");
    expect(status("remote - us, canada, uk, southeast asia, and broader apac.")).not.toBe("INCOMPATIBLE");
    expect(status("fully remote role. the company is headquartered in california and serves us clients.")).toBe("ALLOWED");
    expect(status("this role involves itar/ear controlled technical data and requires an export licence where applicable.")).toBe("ALLOWED");
  });
});
