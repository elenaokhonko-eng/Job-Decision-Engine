/**
 * gate-2026-11.4: the posting's own location header line, the "Office Working" work type
 * and per-fact verification codes.
 *
 * Synthetic postings only: employer names are invented. The template models a common
 * employer header ("Requisition Number: ... Job Location: ... Global Grade: ... Work Type: ...")
 * that stays on one line once HTML is stripped. The authorized region is Singapore
 * (config default). "Standard Chartered" appears only as an entry of the stage3 on-site
 * exception list, as in the user's configuration; the fixture employer on that list is
 * the invented "Northwind Markets".
 */
import { describe, expect, it } from "vitest";
import { applyGlobalGates } from "../../src/services/criteria.js";
import { evaluateHardGatesForJob, remoteTerritoryScopeForPolicy } from "../../src/pipeline/hardGate.js";
import { findPostingLocationLine, isUnknownJobLocation } from "../../src/pipeline/postingLocationLine.js";
import { findExplicitOnsiteStatement, hasOnsiteWorkModeValue } from "../../src/pipeline/onsiteStatements.js";
import { extractWorkModeFromText } from "../../src/services/workModeEnrichment.js";
import { isRoutableWorkabilityVerification } from "../../src/pipeline/verificationRouting.js";
import { loadWorkabilityPolicy, withOnsiteExceptionEmployers, type WorkabilityPolicy } from "../../src/pipeline/workabilityPolicy.js";
import { GATE_VERSION } from "../../src/contracts/version.js";

const basePolicy = loadWorkabilityPolicy();
const EXCEPTION_EMPLOYERS = ["Standard Chartered", "Northwind Markets"];
const exceptionPolicy = withOnsiteExceptionEmployers(basePolicy, EXCEPTION_EMPLOYERS);
const stage3WithExceptions = { mobility: { onsite_exception_employers: EXCEPTION_EMPLOYERS } };

const DUTIES = "Build machine learning data pipelines in Python and Spark for portfolio analytics.";
/** The employer header on one line, then the duties. */
const header = (location: string, workType: string) =>
  `<p>Requisition Number: 240117 Job Location: ${location} Global Grade: D Work Type: ${workType}</p><p>${DUTIES}</p>`;

const STORED_MODES = ["UNKNOWN", "ASSUMED_HYBRID", "HYBRID"] as const;

/** The full hard gate, as runHardGates and the replay use it. */
function fullGate(input: {
  company?: string;
  location?: string;
  workplaceType: string;
  description: string;
  policy?: WorkabilityPolicy;
  stage3?: Record<string, unknown>;
}) {
  const policy = input.policy ?? basePolicy;
  return evaluateHardGatesForJob({
    job: {
      title: "Senior Data Engineer",
      company_name: input.company ?? "Acme Analytics",
      description: input.description,
      location: input.location ?? "Unknown",
      workplace_type: input.workplaceType,
      employment_type: "PERMANENT",
      compensation_raw: null,
    },
    requirements: [],
    profileFacts: [],
    policy,
    stage3Preferences: (input.stage3 ?? {}) as any,
    territoryScope: remoteTerritoryScopeForPolicy(policy),
  });
}

function globalGate(location: string, workplaceType: string, description: string, policy: WorkabilityPolicy = basePolicy) {
  return applyGlobalGates({
    id: "location-line-test",
    title: "Senior Data Engineer",
    company_name: "Acme Analytics",
    source: "test",
    location,
    workplace_type: workplaceType,
    employment_type: "PERMANENT",
    raw_description: description,
  } as any, policy);
}

describe("findPostingLocationLine", () => {
  it("reads a one-line employer header and spells out the alpha-3 code", () => {
    expect(findPostingLocationLine("Requisition Number: 1 Job Location: Singapore, SGP Global Grade: D Work Type: Hybrid Working"))
      .toEqual({ location: "Singapore", quote: "Job Location: Singapore, SGP" });
    expect(findPostingLocationLine("Requisition Number: 1 Job Location: Guangzhou, CHN Global Grade: D Work Type: Office Working"))
      .toEqual({ location: "Guangzhou, China", quote: "Job Location: Guangzhou, CHN" });
  });

  it("reads a Location: line that ends at a newline or separator", () => {
    expect(findPostingLocationLine("About us\nLocation: Singapore\nWe build data platforms.")?.location).toBe("Singapore");
    expect(findPostingLocationLine("Full-time | Location: Kuala Lumpur, Malaysia | Senior")?.location).toBe("Kuala Lumpur, Malaysia");
    expect(findPostingLocationLine("Work Location: Hong Kong. Apply now.")?.location).toBe("Hong Kong");
  });

  it("ignores values without a known territory and words that only contain 'location'", () => {
    expect(findPostingLocationLine("Location: Remote\nBuild things.")).toBeNull();
    expect(findPostingLocationLine("Location: Flexible, to be agreed")).toBeNull();
    expect(findPostingLocationLine("Relocation: Singapore support available")).toBeNull();
    expect(findPostingLocationLine("We have offices in Singapore and London.")).toBeNull();
  });

  it("joins several location lines as alternatives", () => {
    expect(findPostingLocationLine("Location: Singapore\nLocation: London, GBR")?.location).toBe("Singapore / London, United Kingdom");
  });

  it("treats only empty or placeholder structured locations as unknown", () => {
    for (const value of ["Unknown", "", "  ", "N/A", "Not specified", "TBD", "-", null, undefined]) {
      expect(isUnknownJobLocation(value)).toBe(true);
    }
    for (const value of ["Singapore", "Remote", "Guangzhou, China"]) {
      expect(isUnknownJobLocation(value)).toBe(false);
    }
  });
});

describe("Bug B: the location header line establishes the job location", () => {
  it.each(STORED_MODES)("stored %s: a Singapore header with Hybrid Working passes with the quote as evidence", (mode) => {
    const result = fullGate({ workplaceType: mode, description: header("Singapore, SGP", "Hybrid Working") });
    expect(result.status).toBe("PASS");
    expect(result.rejection_codes).toEqual([]);
    expect(result.evidence_quotes).toContain('Job location from the posting: "Job Location: Singapore, SGP"');
  });

  it.each(STORED_MODES)("stored %s: a foreign-only header is GATE_JOB_LOCATION_MISMATCH", (mode) => {
    const result = fullGate({ workplaceType: mode, description: header("Guangzhou, CHN", "Hybrid Working") });
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toEqual(["GATE_JOB_LOCATION_MISMATCH"]);
    expect(result.workability_facts.location_restriction).toBe("CHINA");
    expect(result.evidence_quotes).toContain('Job location from the posting: "Job Location: Guangzhou, CHN"');
  });

  it("never overrides a structured location", () => {
    const result = fullGate({ location: "Singapore", workplaceType: "HYBRID", description: header("Guangzhou, CHN", "Hybrid Working") });
    expect(result.status).toBe("PASS");
    expect(result.evidence_quotes.join(" ")).not.toContain("Job location from the posting");
  });

  it("before the fix, a stored HYBRID job with an unknown location asked for the hiring territory as office days", () => {
    // Without a header line the territory stays unknown; it is now labelled as a territory check.
    const result = fullGate({ workplaceType: "HYBRID", description: `<p>Work Type: Hybrid Working</p><p>${DUTIES}</p>` });
    expect(result.status).toBe("NEEDS_VERIFICATION");
    expect(result.rejection_codes).toEqual(["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_HIRING_TERRITORY"]);
    expect(result.rejection_codes).not.toContain("NEEDS_VERIFICATION_OFFICE_DAYS");
  });

  it("reads a stored ASSUMED_HYBRID as hybrid only when the posting offers hybrid work", () => {
    const offered = fullGate({ location: "Singapore", workplaceType: "ASSUMED_HYBRID", description: `<p>Flexible working arrangements (hybrid).</p><p>${DUTIES}</p>` });
    expect(offered.status).toBe("PASS");
    for (const technical of ["Build hybrid RAG retrieval with knowledge graphs.", "Run hybrid cloud workloads.", "Train a hybrid model for ranking."]) {
      const result = fullGate({ location: "Singapore", workplaceType: "ASSUMED_HYBRID", description: `<p>${technical}</p><p>${DUTIES}</p>` });
      expect(result.status, technical).toBe("NEEDS_VERIFICATION");
      expect(result.rejection_codes, technical).toContain("GATE_UNKNOWN_WORK_MODE");
    }
  });

  it("keeps a Singapore job that says nothing about work mode at NEEDS_VERIFICATION", () => {
    for (const location of ["Singapore", "Unknown"]) {
      const description = location === "Unknown" ? `<p>Job Location: Singapore</p><p>${DUTIES}</p>` : `<p>${DUTIES}</p>`;
      for (const mode of ["UNKNOWN", "ASSUMED_HYBRID"]) {
        const result = fullGate({ location, workplaceType: mode, description });
        expect(result.status, `${location}/${mode}`).toBe("NEEDS_VERIFICATION");
        expect(result.rejection_codes, `${location}/${mode}`).toContain("GATE_UNKNOWN_WORK_MODE");
      }
    }
  });
});

describe("Bug C: Work Type: Office Working is full on-site", () => {
  it.each(STORED_MODES)("stored %s: Office Working rejects without an on-site exception", (mode) => {
    const result = fullGate({ workplaceType: mode, description: header("Singapore, SGP", "Office Working") });
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toEqual(["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"]);
    expect(result.evidence_quotes.join(" ")).toMatch(/work type: office working/i);
  });

  it.each(STORED_MODES)("stored %s: Office Working passes for an exception employer with the exception evidence", (mode) => {
    const result = fullGate({
      company: "Northwind Markets",
      workplaceType: mode,
      description: header("Singapore, SGP", "Office Working"),
      policy: exceptionPolicy,
      stage3: stage3WithExceptions,
    });
    expect(result.status).toBe("PASS");
    expect(result.rejection_codes).toEqual([]);
    const evidence = result.evidence_quotes.join(" ");
    expect(evidence).toMatch(/ON-SITE EXCEPTION \(PREFERRED_EMPLOYER\).*Northwind Markets/);
    expect(evidence).toMatch(/Lifted conflict: .*work type: office working/i);
    expect(evidence).toContain('Job location from the posting: "Job Location: Singapore, SGP"');
  });

  it.each(STORED_MODES)("stored %s: Office-based Working rejects, and passes for an exception employer", (mode) => {
    const description = header("Singapore, SGP", "Office-based Working");
    expect(fullGate({ workplaceType: mode, description }).rejection_codes).toEqual(["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"]);
    const excepted = fullGate({ company: "Northwind Markets", workplaceType: mode, description, policy: exceptionPolicy, stage3: stage3WithExceptions });
    expect(excepted.status).toBe("PASS");
    expect(excepted.evidence_quotes.join(" ")).toMatch(/ON-SITE EXCEPTION \(PREFERRED_EMPLOYER\)/);
  });

  it("a foreign office-working job is still a location mismatch for an exception employer", () => {
    const result = fullGate({
      company: "Northwind Markets",
      workplaceType: "UNKNOWN",
      description: header("Guangzhou, CHN", "Office Working"),
      policy: exceptionPolicy,
      stage3: stage3WithExceptions,
    });
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toEqual(["GATE_JOB_LOCATION_MISMATCH"]);
  });

  it("the gate and work-mode enrichment read the same office work-type values", () => {
    const onsite = [
      "Work Type: Office Working",
      "Work type: Office-based working",
      "Work Type: Office Work",
      "Work model: In-office",
      "Workplace type: Office-based.",
      "Work arrangement: In-office working",
    ];
    for (const line of onsite) {
      const text = `${line}\n${DUTIES}`.toLowerCase();
      expect(findExplicitOnsiteStatement(text, text, { singapore: false }), line).not.toBeNull();
      expect(hasOnsiteWorkModeValue(text), line).toBe(true);
      expect(extractWorkModeFromText(`${line}\n${DUTIES}`).workplace_type, line).toBe("ONSITE");
    }
    const notOnsite = [
      "Location: Office in Singapore",
      "Work Type: Office Working, 3 days a week",
      "Work type: office-based working is optional",
      "Our office-based teams collaborate daily.",
      "Work Type: Hybrid Working",
    ];
    for (const line of notOnsite) {
      const text = `${line}\n${DUTIES}`.toLowerCase();
      expect(findExplicitOnsiteStatement(text, text, { singapore: false }), line).toBeNull();
      expect(hasOnsiteWorkModeValue(text), line).toBe(false);
      expect(extractWorkModeFromText(`${line}\n${DUTIES}`).workplace_type, line).not.toBe("ONSITE");
    }
    expect(extractWorkModeFromText(`Work Type: Hybrid Working\n${DUTIES}`)).toMatchObject({ workplace_type: "HYBRID", office_days_max: 3 });
  });
});

describe("Bug A: each gate verification names its own open fact", () => {
  it("labels an unknown hiring territory as NEEDS_VERIFICATION_HIRING_TERRITORY and still routes", () => {
    const result = globalGate("Unknown", "HYBRID", `Hybrid role. ${DUTIES}`);
    expect(result.status).toBe("NEEDS_VERIFICATION");
    expect(result.rejection_codes).toEqual(["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_HIRING_TERRITORY"]);
    expect(result.evidence_quotes[0]).toBe("Worker hiring territory is not established by employer or source evidence");
    expect(isRoutableWorkabilityVerification("NEEDS_VERIFICATION", result.rejection_codes)).toBe(true);
  });

  it("labels a remote job without a stated territory as a territory check when the policy requires one", () => {
    const policy = { ...basePolicy, remoteWithoutTerritoryAllowed: false, unknownWorkAuthorizationNeedsVerification: false };
    const result = globalGate("Remote", "REMOTE", `Fully remote role. ${DUTIES}`, policy);
    expect(result.status).toBe("NEEDS_VERIFICATION");
    expect(result.rejection_codes).toContain("NEEDS_VERIFICATION_HIRING_TERRITORY");
    expect(result.rejection_codes).not.toContain("NEEDS_VERIFICATION_OFFICE_DAYS");
  });

  it("labels qualitative minimal travel as NEEDS_VERIFICATION_TRAVEL", () => {
    const policy = { ...basePolicy, minimalTravelAllowed: false };
    const result = globalGate("Singapore", "HYBRID", `Hybrid role. Minimal travel. ${DUTIES}`, policy);
    expect(result.status).toBe("NEEDS_VERIFICATION");
    expect(result.rejection_codes).toEqual(["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_TRAVEL"]);
    expect(isRoutableWorkabilityVerification("NEEDS_VERIFICATION", result.rejection_codes)).toBe(true);
  });

  it("keeps NEEDS_VERIFICATION_OFFICE_DAYS for office-day reasons", () => {
    const policy = { ...basePolicy, hybridWithoutOfficeDaysAllowed: false };
    const hybrid = globalGate("Singapore", "HYBRID", `Hybrid role. ${DUTIES}`, policy);
    expect(hybrid.rejection_codes).toEqual(["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_OFFICE_DAYS"]);
    expect(hybrid.evidence_quotes[0]).toBe("Hybrid arrangement listed without explicit office-day count");
  });

  it("keeps every open fact when the territory and the travel are both unresolved", () => {
    // Before, the last pending reason replaced the earlier ones and both were labelled office days.
    const policy = { ...basePolicy, minimalTravelAllowed: false };
    const result = globalGate("Unknown", "HYBRID", `Hybrid role. Minimal travel. ${DUTIES}`, policy);
    expect(result.status).toBe("NEEDS_VERIFICATION");
    expect(result.rejection_codes).toEqual(["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_HIRING_TERRITORY", "NEEDS_VERIFICATION_TRAVEL"]);
    expect(result.evidence_quotes).toEqual([
      "Worker hiring territory is not established by employer or source evidence",
      "The policy does not accept qualitative minimal travel without an explicit percentage",
    ]);
    expect(isRoutableWorkabilityVerification("NEEDS_VERIFICATION", result.rejection_codes)).toBe(true);
  });

  it("pins the gate version for these semantics", () => {
    expect(GATE_VERSION).toBe("gate-2026-11.4");
  });
});
