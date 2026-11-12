/**
 * Government citizenship, security-clearance and "US-based" conditions (gate-2026-11.2).
 *
 * Synthetic postings only: employer names are invented and descriptions model the
 * shape of real postings. The authorized region is Singapore (config default).
 *
 * Rules under test:
 * - A clearance or citizenship condition takes its government from its own clause
 *   (sentence or list item). Nearby text never makes it U.S.; a clause naming no
 *   government is U.S. only when the job itself is located in the US.
 * - A "US-based" placement applies only to a job not located in another territory, must
 *   be addressed to the applicant, and is cancelled by an applicant-addressed opening to
 *   Singapore/SEA/APAC/Asia/worldwide anywhere in the posting.
 * - A remote job located only in the US is a location mismatch unless the posting opens
 *   the role to applicants beyond the US.
 */
import { describe, expect, it } from "vitest";
import { applyGlobalGates } from "../../src/services/criteria.js";
import { evaluateHardGatesForJob, remoteTerritoryScopeForPolicy } from "../../src/pipeline/hardGate.js";
import {
  evaluateWorkerTerritoryRequirements,
  extractExplicitWorkerTerritoryRequirements,
  extractGovernmentEligibilityRequirements,
  isUnitedStatesOnlyLocation,
  loadWorkabilityPolicy,
} from "../../src/pipeline/workabilityPolicy.js";
import { GATE_VERSION } from "../../src/contracts/version.js";
import { TERRITORY_FIXTURES, type GatePolicyFixture } from "./fixtures/g_gate_policy_2026_11.fixtures.js";

const policy = loadWorkabilityPolicy();
const DUTIES = "Design Salesforce data models and integrations for a health records modernization program.";
const BODY = "Build data pipelines in Python and Spark. This is a remote position.";

/** Extraction plus evaluation for a job at `location` (default: location "Remote"). */
function status(text: string, location = "Remote") {
  const requirements = extractExplicitWorkerTerritoryRequirements(text.toLowerCase(), {
    jobLocation: location.toLowerCase(),
    authorizedRegions: ["SINGAPORE"],
  });
  return evaluateWorkerTerritoryRequirements(requirements, ["SINGAPORE"]).status;
}

/** The full hard gate, as runHardGates and the replay use it. */
function fullGate(location: string, workplaceType: string, description: string) {
  return evaluateHardGatesForJob({
    job: {
      title: "Data Platform Engineer",
      company_name: "Synthetic Cloud Works",
      description,
      location,
      workplace_type: workplaceType,
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

function expectWorkAuthReject(location: string, workplaceType: string, description: string) {
  const result = fullGate(location, workplaceType, description);
  expect(result.status, JSON.stringify(result.rejection_codes)).toBe("HARD_REJECT");
  expect(result.rejection_codes).toContain("WORK_AUTHORIZATION_INCOMPATIBLE");
  expect(result.workability_facts.location_restriction).toBe("UNITED_STATES");
  return result;
}

function expectNoWorkAuthReject(location: string, workplaceType: string, description: string) {
  const result = fullGate(location, workplaceType, description);
  expect(result.status, JSON.stringify({ codes: result.rejection_codes, evidence: result.evidence_quotes })).not.toBe("HARD_REJECT");
  expect(result.rejection_codes).not.toContain("WORK_AUTHORIZATION_INCOMPATIBLE");
  return result;
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
    expect(status(text)).toBe("INCOMPATIBLE");
  });

  it("reads a truncated 'S. Citizenship required' as U.S. only with U.S. federal context nearby", () => {
    expect(status("Supports federal health programs.\nS. Citizenship required.")).toBe("INCOMPATIBLE");
    expect(status("Must pass a VA clearance.\nS. Citizenship required.")).toBe("INCOMPATIBLE");
    expect(status("S. Citizenship required.")).toBe("ALLOWED");
    expect(status("Build dashboards for retail clients.\nS. Citizenship required.")).toBe("ALLOWED");
    expect(status("Supports federal health programs.\nS. Citizenship preferred.")).toBe("ALLOWED");
    expect(status("Supports federal health programs.\nS. Citizenship required.", "Singapore")).toBe("ALLOWED");
  });

  it("quotes the truncated line and its U.S. context as evidence", () => {
    const [requirement] = extractGovernmentEligibilityRequirements("Supports federal health programs.\nS. Citizenship required.", { jobLocation: "Remote" });
    expect(requirement?.territories).toEqual(["UNITED_STATES"]);
    expect(requirement?.evidenceText).toMatch(/^S\. Citizenship required\..*federal health programs/);
  });
});

describe("clearances take their government from their own clause", () => {
  it.each([
    ["Must be able to obtain and maintain any required federal background investigation or VA clearance.", "UNITED_STATES"],
    ["Ability to obtain and maintain a Public Trust clearance.", "UNITED_STATES"],
    ["Active TS/SCI clearance with polygraph required.", "UNITED_STATES"],
    ["Active DoD Secret security clearance.", "UNITED_STATES"],
    ["Must hold an active U.S. Government security clearance.", "UNITED_STATES"],
    ["Clearance: TS/SCI with Polygraph", "UNITED_STATES"],
    ["Must hold current SC clearance.", "UNITED_KINGDOM"],
    ["Must hold NV1 security clearance.", "AUSTRALIA"],
  ])("rejects %s as a %s government requirement", (text, government) => {
    const requirements = extractGovernmentEligibilityRequirements(text.toLowerCase(), { jobLocation: "remote" });
    expect(requirements.map((r) => r.territories[0])).toContain(government);
    expect(status(text)).toBe("INCOMPATIBLE");
  });

  it("reads a clearance that names no government as U.S. only on a US-located job", () => {
    const text = "Must hold an active Secret clearance.\nSupports Department of Defense mission systems.";
    expect(status(text, "Remote, United States")).toBe("INCOMPATIBLE");
    expect(status(text, "Austin, TX")).toBe("INCOMPATIBLE");
    expect(status(text, "Remote")).toBe("ALLOWED");
    expect(status(text, "Singapore")).toBe("ALLOWED");
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
    "Must hold an active security clearance (Singapore or U.S.).",
    "Must hold an active security clearance with the U.S. Navy or Republic of Singapore Navy.",
  ])("does not reject %s", (text) => {
    expect(status(text)).toBe("ALLOWED");
  });
});

describe("round-4 blocking 1: a bare clearance on a Singapore job is never U.S. from context", () => {
  it.each([
    ["Singapore", "HYBRID", "Successful candidates must be able to pass security clearance. You will deliver digital services for government agencies."],
    ["Singapore", "HYBRID", "Must be able to obtain security clearance. This role supports government agencies."],
    ["Singapore", "HYBRID", "Must be able to obtain security clearance. You will work on government contracts for public-sector clients."],
    ["Singapore", "HYBRID", "Must be eligible for security clearance. The role supports federal agencies and ministries."],
    ["Singapore (Remote)", "REMOTE", "Must hold an active security clearance. Our clients are federal agencies in the region."],
    ["Singapore", "HYBRID", "Experience with U.S. GAAP and IFRS reporting. Must hold an active security clearance."],
    ["Singapore", "HYBRID", "Must hold a current security clearance. You will support our US-based clients."],
    ["Singapore", "HYBRID", "Must be able to obtain a security clearance. Coverage of USA equities and fixed income."],
    ["Singapore", "HYBRID", "Experience with United States FDA submissions. Must hold current clearance to access restricted areas."],
    ["Singapore", "HYBRID", "Must hold an active security clearance. You will brief U.S. and allied partners."],
    ["Singapore", "HYBRID", "Must hold an active security clearance. Prior experience with the US Army Corps of Engineers is a plus."],
    ["Singapore (Remote)", "REMOTE", "Must hold an active security clearance. You will support Navy programmes."],
    ["Singapore", "HYBRID", "Must hold an active security clearance. Experience with VA systems is an advantage."],
    ["Singapore", "HYBRID", "Officers must maintain public trust and uphold the integrity of the regulator."],
  ])("%s / %s: %s", (location, workplaceType, text) => {
    expectNoWorkAuthReject(location, workplaceType, `Build data quality checks in Python. Hybrid, 2 days a week in the office. ${text}`);
  });

  it("does not take a bare clearance as U.S. from EEO, benefits or legal boilerplate on a Remote job", () => {
    const text = [
      "Active security clearance required.",
      "Build data pipelines in Python.",
      "We are an equal opportunity employer in the United States. All qualified applicants receive consideration without regard to race, religion, national origin, disability or protected veteran status, as protected by federal, state or local law.",
      "We offer competitive benefits, including 401(k) and health insurance, to employees in the USA.",
    ].join("\n");
    expect(status(text)).toBe("ALLOWED");
  });
});

describe("round-4 blocking 2: US-based wording", () => {
  it.each([
    ["Remote", "REMOTE", "This is a remote, US-based role. Candidates in Singapore are also welcome."],
    ["Remote", "REMOTE", "Open to US-based candidates; Singapore candidates are also considered."],
    ["Remote", "REMOTE", "<ul><li>US-based candidates</li><li>Singapore-based candidates</li></ul>"],
    ["Remote", "REMOTE", "Open to US-based candidates or those in Southeast Asian markets."],
    ["Singapore", "HYBRID", "This role is not open to US-based candidates. It is based in our Singapore office."],
    ["Singapore", "HYBRID", "US-based candidates preferred."],
    ["Singapore", "HYBRID", "You will coordinate US-based consultants and vendors."],
    ["Singapore", "HYBRID", "You will onboard US-based hires and support the global people team."],
    ["Singapore", "HYBRID", "As a recruiter, you will source US-based talent for our clients."],
    ["Singapore", "HYBRID", "This is a remote, US-based role."],
    ["Remote", "REMOTE", "This role is open to US-based candidates or candidates in Singapore."],
    ["Remote", "REMOTE", "This role is open to US-based candidates as well as those in APAC."],
    ["Remote", "REMOTE", "We welcome US-based or Singapore-based applicants for this role."],
    ["Remote", "REMOTE", "This role is open to US-based candidates and talent anywhere in Asia."],
    ["Remote", "REMOTE", "We consider US-based candidates as well as candidates worldwide."],
    ["Singapore", "HYBRID", "This cloud-based role supports clients across Japan."],
  ])("%s / %s: %s", (location, workplaceType, text) => {
    expectNoWorkAuthReject(location, workplaceType, `Build ML pipelines in Python. Hybrid, 2 days a week in the office. ${text}`);
  });

  it.each([
    "This is a remote, US-based role.",
    "This is a U.S.-based remote role.",
    "This is a United States-based position.",
    "We are hiring California-based candidates for this role.",
    "We are hiring US-based or Canada-based candidates for this role.",
    "This is a US based remote role.",
    "This role is US-based.",
    "We are hiring a U.S.-based data engineer.",
    "We are hiring US-based candidates only.",
  ])("rejects an applicant-addressed US placement on a Remote job: %s", (text) => {
    expectWorkAuthReject("Remote", "REMOTE", `${BODY} ${text}`);
  });

  it("does not treat employer, pay or benefit mentions of US-based as a restriction", () => {
    expect(status("We are a US-based company with clients worldwide.")).toBe("ALLOWED");
    expect(status("We provide U.S.-based employees with a comprehensive benefits package.")).toBe("ALLOWED");
    expect(status("For this US-based position, the base pay range is $100,000 to $120,000.")).toBe("ALLOWED");
    expect(status("Join us based on your experience.")).toBe("ALLOWED");
  });
});

describe("remote jobs located only in the United States", () => {
  it.each([
    ["United States", BODY],
    ["Remote (US)", BODY],
    ["US - Remote", BODY],
    ["Anywhere in the US", BODY],
    ["California", BODY],
    ["Texas, United States", BODY],
    ["Austin, TX", BODY],
    ["Denver, CO (Remote)", BODY],
    ["United States (Remote)", BODY],
    ["Remote, United States", BODY],
    ["United States", `${BODY} You can work from anywhere in the US.`],
    ["Remote, United States", `${BODY} Work from anywhere in the U.S.`],
    // Round-4 non-blocking: incidental wording does not open the role.
    ["Remote, United States", `${BODY} We are a worldwide leader in payments.`],
    ["Remote, United States", `${BODY} We serve clients in Asia and Europe.`],
    ["Remote, United States", `${BODY} Our APAC team is based in Tokyo.`],
    ["Remote, United States", `${BODY} Work from anywhere within the continental US.`],
    ["Remote, United States", `${BODY} Work from anywhere in America.`],
    ["Remote, United States", `${BODY} Work from anywhere in the lower 48 states.`],
    ["Austin, TX", `${BODY} Our team spans North America and Asia.`],
    ["Remote, United States", `${BODY} This role is not open to candidates in Singapore.`],
  ])("rejects %s with a remote flag as GATE_JOB_LOCATION_MISMATCH (%s)", (location, description) => {
    const result = fullGate(location, "REMOTE", description);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_JOB_LOCATION_MISMATCH");
    expect(result.workability_facts.location_restriction).toBe("UNITED_STATES");
  });

  it.each([
    ["United States", `${BODY} Work from anywhere: we hire across time zones.`],
    ["United States", `${BODY} This is a global remote role.`],
    ["California", `${BODY} We are open to candidates worldwide.`],
    ["Remote (US)", `${BODY} Candidates in Singapore are also welcome.`],
    ["United States", `${BODY} We are hiring across APAC.`],
    ["Remote, United States", `${BODY} This role is open internationally.`],
    // Multi-sentence, semicolon and list openings: the whole description is read.
    ["Remote, United States", `${BODY}\nThis is a remote, US-based role.\nCandidates in Singapore are also welcome.`],
    ["Remote, United States", `${BODY} Open to US-based candidates; Singapore candidates are also considered.`],
    ["Remote, United States", `${BODY}<ul><li>US-based candidates</li><li>Singapore-based candidates</li></ul>`],
    ["Remote, United States", `${BODY} Open to US-based candidates or those in Southeast Asian markets.`],
    ["Remote, United States", `${BODY} Location: Remote - US, Canada, UK, Southeast Asia, and broader APAC.`],
  ])("passes %s when the posting opens the role to applicants beyond the US (%s)", (location, description) => {
    const result = fullGate(location, "REMOTE", description);
    expect(result.status, JSON.stringify(result.rejection_codes)).not.toBe("HARD_REJECT");
    expect(result.rejection_codes).not.toContain("GATE_JOB_LOCATION_MISMATCH");
  });

  it("passes a US-headquartered company hiring in Singapore", () => {
    const result = fullGate("Singapore", "REMOTE", "We are a company headquartered in San Francisco, California. Build data pipelines in Python. This is a remote position.");
    expect(result.status).toBe("PASS");
  });

  it("leaves bare 'Remote' and non-remote US locations to the existing rules", () => {
    expect(fullGate("Remote", "REMOTE", BODY).status).toBe("PASS");
    expect(fullGate("Austin, TX", "HYBRID", "Build data pipelines in Python. Hybrid, 2 days a week in the office.").rejection_codes)
      .not.toContain("WORK_AUTHORIZATION_INCOMPATIBLE");
  });

  it("recognises US-only locations and nothing else", () => {
    expect(isUnitedStatesOnlyLocation("United States")).toBe(true);
    expect(isUnitedStatesOnlyLocation("Boston, MA")).toBe(true);
    expect(isUnitedStatesOnlyLocation("Washington, DC")).toBe(true);
    expect(isUnitedStatesOnlyLocation("Singapore")).toBe(false);
    expect(isUnitedStatesOnlyLocation("Toronto, ON")).toBe(false);
    expect(isUnitedStatesOnlyLocation("Tbilisi, Georgia")).toBe(false);
    expect(isUnitedStatesOnlyLocation("United States / Singapore")).toBe(false);
    expect(isUnitedStatesOnlyLocation("Remote")).toBe(false);
  });
});

describe("round-5 blocking 1: a negation cancels only the opening or placement it governs", () => {
  it.each([
    ["Remote", "This is a remote, US-based role. Candidates in Singapore are also welcome, no relocation needed."],
    ["Remote", "This is a remote, US-based role. Open to applicants in APAC with no visa sponsorship required."],
    ["Remote", "This is a remote, US-based role. We are not limited to the US: candidates in Singapore are welcome."],
    ["Remote, United States", "Open to applicants worldwide, no relocation required."],
    ["Remote, United States", "Candidates across APAC are welcome, no visa sponsorship needed."],
    ["Remote, United States", "You can work from Singapore, no need to relocate."],
    ["Remote, United States", "We hire globally and never require office attendance."],
  ])("%s: %s opens the role", (location, text) => {
    const result = fullGate(location, "REMOTE", `${BODY} ${text}`);
    expect(result.status, JSON.stringify({ codes: result.rejection_codes, evidence: result.evidence_quotes })).not.toBe("HARD_REJECT");
    expect(result.rejection_codes).not.toContain("WORK_AUTHORIZATION_INCOMPATIBLE");
    expect(result.rejection_codes).not.toContain("GATE_JOB_LOCATION_MISMATCH");
  });

  it.each([
    "This role is not open to candidates in Singapore.",
    "We cannot hire in APAC.",
    "No candidates outside the US will be considered.",
    "Candidates are welcome from anywhere except Singapore.",
    "This role is not open to applicants worldwide.",
  ])("a negated opening still does not open a US-located remote role: %s", (text) => {
    const result = fullGate("Remote, United States", "REMOTE", `${BODY} ${text}`);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_JOB_LOCATION_MISMATCH");
  });

  it.each([
    "This is a US-based role and we are not able to sponsor visas.",
    "This role is US-based and is not open to international candidates.",
    "This position is US-based with no international hiring.",
  ])("a negation beside a US-based placement does not cancel it: %s", (text) => {
    expectWorkAuthReject("Remote", "REMOTE", `${BODY} ${text}`);
  });

  it("a negation of the placement itself still cancels it", () => {
    expectNoWorkAuthReject("Remote", "REMOTE", `${BODY} This role is not open to US-based candidates.`);
    expectNoWorkAuthReject("Remote", "REMOTE", `${BODY} This is not a US-based role, and you can work from any time zone.`);
  });
});

describe("round-5 blocking 2: empty clearance headers are not requirements", () => {
  it.each([
    "Open to candidates worldwide. Clearance: None.",
    "Open to candidates worldwide. Security clearance: N/A.",
    "Open to candidates worldwide. Security Clearance: Not Applicable.",
    "Open to candidates worldwide. Clearance: Not required.",
    "Open to candidates worldwide. Clearance Required: No.",
  ])("United States / REMOTE: %s", (text) => {
    const result = fullGate("United States", "REMOTE", `${BODY} ${text}`);
    expect(result.status, JSON.stringify({ codes: result.rejection_codes, evidence: result.evidence_quotes })).toBe("PASS");
  });

  it("still reads a header that names a clearance as a requirement", () => {
    expectWorkAuthReject("Remote", "REMOTE", `${BODY} Clearance: TS/SCI with Polygraph`);
    expectWorkAuthReject("United States", "REMOTE", `${BODY} Open to candidates worldwide. Clearance: Secret.`);
  });
});

describe("round-5 non-blocking fixes", () => {
  it.each([
    "You will be hiring US-based engineers for the platform team.",
    "You will be looking for US-based consultants to staff client projects.",
  ])("the applicant hiring US-based staff is not a placement: %s", (text) => {
    expectNoWorkAuthReject("Remote", "REMOTE", `${BODY} ${text}`);
  });

  it.each([
    "Employees based in APAC are eligible for our regional benefits plan.",
    "Our APAC hires receive a home-office stipend.",
    "Work from anywhere in the Americas.",
    "Work from anywhere in North America.",
    "Work from anywhere in Canada or the US.",
    "Work from anywhere in the EU or US.",
    "We welcome candidates from the Asian American and Pacific Islander communities.",
  ])("does not open a US-located remote role: %s", (text) => {
    const result = fullGate("Remote, United States", "REMOTE", `${BODY} ${text}`);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_JOB_LOCATION_MISMATCH");
  });

  it.each([
    "Work from anywhere in Asia.",
    "Location: Remote - APAC.",
    "We are open to hiring in Singapore.",
    "This role can be performed remotely from Singapore.",
    "Applicants from Southeast Asia will be considered.",
    "<ul><li>Location: United States or Singapore</li></ul>",
    "Work from anywhere in the US or Asia.",
    "We hire worldwide. No relocation needed.",
    "Candidates outside the US, including Singapore, are also welcome.",
    // A global opening inside a pay line still counts; only region + "eligible"/"hires" there does not.
    "We use geo ranges as part of our global compensation strategy while we are hiring globally.",
  ])("genuine openings still open a US-located remote role: %s", (text) => {
    const result = fullGate("Remote, United States", "REMOTE", `${BODY} ${text}`);
    expect(result.rejection_codes).not.toContain("GATE_JOB_LOCATION_MISMATCH");
  });

  it("reads MINDEF as a Singapore government reference", () => {
    expectNoWorkAuthReject("Singapore", "HYBRID", "Build data pipelines. Hybrid, 2 days a week in the office. Must hold an active clearance from the Department of the Navy or MINDEF.");
  });
});

describe("round 6: benefits frame, clearance header values, relative-clause and parenthetical negation", () => {
  it.each([
    "This is a remote, US-based role. Candidates in Singapore are also welcome and receive competitive benefits.",
    "This is a remote, US-based role. Location: Remote (Singapore), salary range SGD 8,000-10,000.",
    "This is a remote, US-based role. Also open to applicants based in Singapore who aren't able to relocate.",
  ])("Remote: a Singapore opening beside pay, benefits or a relative clause cancels the US placement: %s", (text) => {
    expectNoWorkAuthReject("Remote", "REMOTE", `${BODY} ${text}`);
  });

  it.each([
    "We hire in Singapore and offer competitive compensation.",
    "Open to candidates in Singapore or Malaysia who do not require sponsorship.",
    "Candidates in APAC who cannot relocate are welcome.",
    "Open to candidates worldwide (no relocation).",
    "Open to candidates in Singapore (no visa sponsorship).",
  ])("Remote, United States: still an opening: %s", (text) => {
    const result = fullGate("Remote, United States", "REMOTE", `${BODY} ${text}`);
    expect(result.rejection_codes).not.toContain("GATE_JOB_LOCATION_MISMATCH");
  });

  it.each([
    "Employees based in APAC are eligible for our regional benefits plan.",
    "Our APAC hires receive a home-office stipend.",
    "New hires in APAC receive a setup allowance.",
    "Applicants in APAC won't be considered.",
    "Applicants from Singapore are ineligible.",
    "We don't hire in Singapore or anywhere in Asia.",
    "We can't hire outside the US, so Singapore candidates won't be considered.",
    "Applicants from Singapore will not be considered.",
  ])("Remote, United States: not an opening: %s", (text) => {
    const result = fullGate("Remote, United States", "REMOTE", `${BODY} ${text}`);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_JOB_LOCATION_MISMATCH");
  });

  it.each([
    "Clearance: None at this time.",
    "Clearance: None | Travel: 10%.",
    "Clearance: N/A - remote role.",
    "Clearance: TBD.",
    "Clearance: Not specified.",
    "Clearance: None.",
    "Security clearance: N/A.",
    "Security Clearance: Not Applicable.",
  ])("United States / REMOTE, open worldwide: a header whose value names no clearance is no requirement: %s", (text) => {
    const result = fullGate("United States", "REMOTE", `${BODY} Open to candidates worldwide. ${text}`);
    expect(result.status, JSON.stringify({ codes: result.rejection_codes, evidence: result.evidence_quotes })).toBe("PASS");
  });

  it.each([
    "Clearance: Secret.",
    "Clearance Level: Top Secret.",
    "Clearance: TS/SCI with Polygraph",
    "Clearance: Public Trust",
    "Security clearance: active Confidential",
    "Clearance: Must be eligible to obtain a Secret clearance",
  ])("United States / REMOTE, open worldwide: a header that names a clearance is a requirement: %s", (text) => {
    expectWorkAuthReject("United States", "REMOTE", `${BODY} Open to candidates worldwide. ${text}`);
  });
});

describe("round 7: applicant-addressed benefit lines, negative header values, head-clause negation", () => {
  it.each([
    "Candidates in Singapore are welcome and are eligible for our equity plan.",
    "Open to candidates in Singapore, who will be eligible for local benefits.",
    "Candidates based in Singapore are eligible for this role and our full benefits.",
    "Applicants in APAC are eligible for remote work under our flexible work plan.",
  ])("Remote, US-based role: an applicant-addressed opening that mentions benefits cancels the placement: %s", (text) => {
    expectNoWorkAuthReject("Remote", "REMOTE", `${BODY} This is a remote, US-based role. ${text}`);
  });

  it.each([
    "Clearance: None required (non-government role).",
    "Clearance: Background check only, no government clearance.",
    "Clearance: N/A (commercial, not federal).",
    "Clearance: None - commercial client, no DoD work.",
    "Clearance: No active clearance needed.",
    "Clearance: None (VA healthcare data, HIPAA training only).",
  ])("United States / REMOTE, open worldwide: a header value that starts negative is no requirement: %s", (text) => {
    const result = fullGate("United States", "REMOTE", `${BODY} Open to candidates worldwide. ${text}`);
    expect(result.status, JSON.stringify({ codes: result.rejection_codes, evidence: result.evidence_quotes })).toBe("PASS");
  });

  it.each([
    "We are not able to hire candidates who are based in Singapore.",
    "We cannot accept candidates that live in APAC.",
  ])("Remote, United States: a head-clause negation governs its relative clause: %s", (text) => {
    const result = fullGate("Remote, United States", "REMOTE", `${BODY} ${text}`);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_JOB_LOCATION_MISMATCH");
  });
});

describe("genuine US-only wordings stay rejected (review positives)", () => {
  it.each([
    "US Citizens only.",
    "Only U.S. citizens will be considered.",
    "Citizenship: U.S. citizen.",
    "Must be a U.S citizen",
    "Green card holders or US citizens only.",
    "This position requires U.S. citizenship due to federal contract requirements.",
    "Requires an active U.S. Government security clearance.",
    "Must be eligible to obtain a U.S. government security clearance.",
    "Must be able to obtain a Public Trust clearance.",
    "This is a U.S.-based remote role.",
  ])("Remote job: %s", (text) => {
    expectWorkAuthReject("Remote", "REMOTE", `${BODY} ${text}`);
  });

  it("rejects a bare clearance with Department of Defense customers on a US-located job", () => {
    expectWorkAuthReject("Remote, United States", "REMOTE", `${BODY} Must hold an active security clearance. Support Department of Defense customers.`);
  });

  it("rejects 'Work from anywhere in the U.S.' on a US remote location as a location mismatch", () => {
    const result = fullGate("Remote, United States", "REMOTE", `${BODY} Work from anywhere in the U.S.`);
    expect(result.rejection_codes).toContain("GATE_JOB_LOCATION_MISMATCH");
  });

  it("passes the control: a Singapore job partnering with U.S. and European stakeholders", () => {
    expect(fullGate("Singapore", "HYBRID", "Build data pipelines. Hybrid, 2 days a week in the office. Partner with stakeholders in the U.S. and Europe.").status).toBe("PASS");
  });
});

describe("end to end through the hard gate", () => {
  it("hard-rejects the truncated-citizenship federal posting with quoted evidence", () => {
    const result = expectWorkAuthReject("Remote", "REMOTE", TRUNCATED_US_POSTING);
    const evidence = result.evidence_quotes.join(" ");
    expect(evidence).toMatch(/s\. citizenship required/i);
    expect(evidence).toMatch(/federal background investigation or va clearance/i);
  });

  it("still passes the same posting when the security section is absent", () => {
    expect(fullGate("Remote", "REMOTE", `<h3>Remote</h3><p>${DUTIES}</p>`).status).toBe("PASS");
  });

  it("bumps the gate version so stored decisions are re-gated", () => {
    // 11.2 introduced these rules; 11.3 (#177, neutral workplace perks and the
    // Singapore on-site rule) and 11.4 (location header line, office work type, verification
    // open-fact codes) and 11.5 (pre-sales titles) followed, so the current version is later than 11.2.
    expect(GATE_VERSION).toBe("gate-2026-11.5");
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
    expect(status("Candidates must be based in Southeast Asia.")).toBe("ALLOWED");
    expect(status("Remote - US, Canada, UK, Southeast Asia, and broader APAC.")).not.toBe("INCOMPATIBLE");
    expect(status("Fully remote role. The company is headquartered in California and serves US clients.")).toBe("ALLOWED");
    expect(status("This role involves ITAR/EAR controlled technical data and requires an export licence where applicable.")).toBe("ALLOWED");
  });
});
