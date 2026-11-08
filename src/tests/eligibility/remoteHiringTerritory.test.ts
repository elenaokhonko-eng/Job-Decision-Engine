import { describe, expect, it } from "vitest";

import { assessRemoteHiringTerritory, type RemoteTerritoryInput } from "../../eligibility/remoteHiringTerritory.js";
import { buildDiscoveryLocationScope, loadLocationScopeConfig } from "../../ingestion/discoveryLocationScope.js";
import { applyRemoteTerritoryGate } from "../../pipeline/hardGate.js";

// The production location_scope block, so the test checks the shipped region terms.
const CONFIG = loadLocationScopeConfig();
if (!CONFIG) throw new Error("config/source-plans/six_lane_sources.yml must define location_scope.");
const SCOPE = buildDiscoveryLocationScope(CONFIG, { authorizedRegions: ["SINGAPORE"], rejectExplicitForeignTerritory: true });

const BODY = "Example Corp builds payments infrastructure. You will design services, review code and mentor engineers.";

function posting(overrides: Partial<RemoteTerritoryInput>): RemoteTerritoryInput {
  return { sourceName: "HIMALAYAS", location: "Remote", workplaceType: "REMOTE", description: BODY, ...overrides };
}

function assess(overrides: Partial<RemoteTerritoryInput>) {
  return assessRemoteHiringTerritory(posting(overrides), SCOPE);
}

describe("remote hiring territory: board candidate-region field", () => {
  it.each([
    ["USA", "RESTRICTED_FOREIGN"],
    ["Canada,  USA", "RESTRICTED_FOREIGN"],
    ["EMEA,  LATAM,  Canada,  USA", "RESTRICTED_FOREIGN"],
    ["Europe,  UK", "RESTRICTED_FOREIGN"],
    ["Bulgaria", "RESTRICTED_FOREIGN"],
    ["USA Only", "RESTRICTED_FOREIGN"],
    ["APAC", "UNRESTRICTED"],
    ["Hong Kong,  Singapore", "UNRESTRICTED"],
    ["APAC,  EMEA", "UNRESTRICTED"],
    ["Anywhere", "UNRESTRICTED"],
    ["Worldwide", "UNRESTRICTED"],
  ])("reads Jobicy region %s as %s", (location, status) => {
    expect(assess({ sourceName: "JOBICY", location }).status).toBe(status);
  });

  it("does not treat an unknown board label as a restriction", () => {
    expect(assess({ sourceName: "JOBICY", location: "Unknown" }).status).toBe("UNRESTRICTED");
  });

  it("keeps the old meaning for employer boards: an office location is not a candidate region", () => {
    expect(assess({ sourceName: "GREENHOUSE", location: "Remote", description: BODY }).status).toBe("UNRESTRICTED");
    expect(assess({ sourceName: "GREENHOUSE", location: "London", workplaceType: "HYBRID" }).status).toBe("NOT_APPLICABLE");
  });
});

describe("remote hiring territory: description signals", () => {
  it("rejects a pay range defined for every market in one foreign country", () => {
    const result = assess({ description: `${BODY} The base pay for this position ranges from $75,000 to $100,000/yr CAD within any geographic market in Canada.` });
    expect(result.status).toBe("RESTRICTED_FOREIGN");
    expect(result.territories).toEqual(["CANADA"]);
    expect(result.signals[0]?.evidence).toContain("geographic market in Canada");
  });

  it.each([
    "Location: Remote (US)",
    "This position is 100% remote within LatAm.",
    "Location: 100% Remote (U.S.)",
    "You will work remotely from Bulgaria and report to a local lead.",
  ])("rejects a clear remote territory statement: %s", (sentence) => {
    expect(assess({ description: `${sentence}\n${BODY}` }).status).toBe("RESTRICTED_FOREIGN");
  });

  it("reads a board 'Headquarters: Remote - XX' line as the job location", () => {
    const result = assess({ sourceName: "WE_WORK_REMOTELY", location: "Anywhere in the World", description: `Headquarters: Remote - MX\n${BODY}` });
    expect(result).toMatchObject({ status: "RESTRICTED_FOREIGN", territories: ["MEXICO"] });
  });

  it("asks for verification when only weak hints exist", () => {
    expect(assess({ sourceName: "WE_WORK_REMOTELY", location: "Anywhere in the World", description: `Headquarters: Austin, Texas, USA\n${BODY}` }).status).toBe("UNCLEAR");
    expect(assess({ description: `${BODY}\nMexico Benefits: medical insurance, savings fund.` }).status).toBe("UNCLEAR");
  });

  it("treats working-hours wording as weak, not a territory restriction", () => {
    expect(assess({ description: `Remote (US hours)\n${BODY}` }).status).toBe("UNCLEAR");
    expect(assess({ description: `This role may be remote in EMEA time zones.\n${BODY}` }).status).toBe("UNCLEAR");
  });

  it("asks for verification when a strong signal is contradicted by a global hiring statement", () => {
    const result = assess({ sourceName: "JOBICY", location: "Europe", description: `${BODY} Applicants from any country are welcome to apply.` });
    expect(result.status).toBe("UNCLEAR");
    expect(result.counterEvidence[0]).toContain("any country");
  });

  it("ignores global words that are not about hiring", () => {
    expect(assess({ description: `Location: Remote (US)\n${BODY} We serve enterprises worldwide.` }).status).toBe("RESTRICTED_FOREIGN");
  });

  it("allows a posting that names an authorized region", () => {
    expect(assess({ description: `Location: Remote (US) or Remote (Singapore)\n${BODY}` }).status).toBe("UNRESTRICTED");
  });

  it("does not invent a territory from unrelated words after 'remote'", () => {
    expect(assess({ description: `This work is remote in nature and asynchronous.\n${BODY}` }).status).toBe("UNRESTRICTED");
  });
});

describe("remote territory gate", () => {
  it("hard-rejects with the reason code and quoted evidence", () => {
    const result = applyRemoteTerritoryGate(posting({ sourceName: "JOBICY", location: "USA" }), SCOPE);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toEqual(["WORK_AUTHORIZATION_INCOMPATIBLE", "GATE_REMOTE_TERRITORY_RESTRICTED"]);
    expect(result.evidence_quotes.join(" ")).toContain('"USA"');
    expect(result.workability_facts.location_restriction).toBe("UNITED_STATES");
  });

  it("routes unclear territory to NEEDS_VERIFICATION, never a guessed rejection", () => {
    const result = applyRemoteTerritoryGate(posting({ description: `${BODY}\nMexico Benefits: medical insurance.` }), SCOPE);
    expect(result.status).toBe("NEEDS_VERIFICATION");
    expect(result.rejection_codes).toEqual(["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_HIRING_TERRITORY"]);
  });

  it("passes when no scope is configured", () => {
    expect(applyRemoteTerritoryGate(posting({ sourceName: "JOBICY", location: "USA" }), null).status).toBe("PASS");
  });
});
