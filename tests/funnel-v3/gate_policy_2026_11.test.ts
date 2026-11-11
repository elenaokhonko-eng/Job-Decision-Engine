import { describe, expect, it } from "vitest";
import { applyGlobalGates } from "../../src/services/criteria.js";
import {
  applyPersistedRequirementGates,
  applyRemoteTerritoryGate,
  remoteTerritoryScopeForPolicy,
  resolveOnsiteExceptionPolicy,
} from "../../src/pipeline/hardGate.js";
import {
  extractExplicitWorkerTerritoryRequirements,
  evaluateWorkerTerritoryRequirements,
  isTerritoryAuthorized,
  loadWorkabilityPolicy,
  withOnsiteExceptionEmployers,
  type WorkabilityPolicy,
} from "../../src/pipeline/workabilityPolicy.js";
import { employerNameMatches, findOnsiteException } from "../../src/pipeline/onsiteExceptions.js";
import {
  GATE_REASON_LABELS,
  gateReasonLabel,
  LIFESTYLE_GATE_CODES,
} from "../../src/pipeline/gateReasonCodes.js";
import { classifyRepairCategory } from "../../src/pipeline/repairClassification.js";
import { evaluateMobilityMatch } from "../../src/policy/stage3PolicyEngine.js";
import { Stage3WorkPreferencesSchema } from "../../src/policy/stage3Contracts.js";
import { PersistedGateDecisionSchema } from "../../src/contracts/index.js";
import { GATE_VERSION } from "../../src/contracts/version.js";
import {
  FUNCTION_DOMAIN_FIXTURES,
  LIFESTYLE_FIXTURES,
  ONSITE_FIXTURES,
  REMOTE_LIST_DESCRIPTION,
  TERRITORY_FIXTURES,
  UNCHANGED_FIXTURES,
  type GatePolicyFixture,
} from "./fixtures/g_gate_policy_2026_11.fixtures.js";

const basePolicy = loadWorkabilityPolicy();

function gate(fixture: GatePolicyFixture, policy: WorkabilityPolicy = basePolicy) {
  return applyGlobalGates({
    id: fixture.id,
    title: fixture.title,
    company_name: fixture.company_name,
    location: fixture.location,
    workplace_type: fixture.workplace_type,
    employment_type: "PERMANENT",
    raw_description: fixture.raw_description,
  } as any, policy);
}

function expectFixture(fixture: GatePolicyFixture, policy: WorkabilityPolicy = basePolicy) {
  const result = gate(fixture, policy);
  expect(result.status, `${fixture.id}: ${fixture.notes} -> ${JSON.stringify(result.rejection_codes)}`).toBe(fixture.expectedStatus);
  for (const code of fixture.expectedCodes ?? []) expect(result.rejection_codes, fixture.id).toContain(code);
  for (const code of fixture.forbiddenCodes ?? []) expect(result.rejection_codes, fixture.id).not.toContain(code);
  if (fixture.expectedEvidence) {
    expect(result.evidence_quotes.some((quote) => fixture.expectedEvidence!.test(quote)), `${fixture.id} evidence ${JSON.stringify(result.evidence_quotes)}`).toBe(true);
  }
  return result;
}

describe("Gate policy 2026-11 — rule 1: on-site exceptions", () => {
  it("keeps the global rule: a full-time on-site commercial role is rejected without an exception", () => {
    expectFixture(ONSITE_FIXTURES.G05);
    expectFixture(ONSITE_FIXTURES.G03);
  });

  it("G01: lets a university employer's on-site role pass and records the exception", () => {
    const result = expectFixture(ONSITE_FIXTURES.G01);
    expect(result.evidence_quotes.join(" ")).toMatch(/Lifted conflict: onsite work mode/);
  });

  it("G02: lets a research title pass on-site at a commercial employer", () => {
    expectFixture(ONSITE_FIXTURES.G02);
  });

  it("G04: lets a hospital research unit pass, but not a non-research hospital role", () => {
    expectFixture(ONSITE_FIXTURES.G04);
    expectFixture(ONSITE_FIXTURES.G04B);
  });

  it("G05/G06: applies user-preferred employers only when the preference lists them", () => {
    const withList = withOnsiteExceptionEmployers(basePolicy, ["Northwind Markets", "AcmeBank"]);
    const listed = gate(ONSITE_FIXTURES.G05, withList);
    expect(listed.status).toBe("PASS");
    expect(listed.evidence_quotes.join(" ")).toMatch(/ON-SITE EXCEPTION \(PREFERRED_EMPLOYER\).*Northwind Markets Singapore/);
    expectFixture(ONSITE_FIXTURES.G06, withList);
    // No field means no exception (backward compatible).
    expect(gate(ONSITE_FIXTURES.G06).status).toBe("HARD_REJECT");
    expect(withOnsiteExceptionEmployers(basePolicy, undefined)).toBe(basePolicy);
    expect(withOnsiteExceptionEmployers(basePolicy, [])).toBe(basePolicy);
  });

  it("matches employer names on whole words or a long name prefix only", () => {
    expect(employerNameMatches("Standard Example Bank Singapore", "Standard Example Bank")).toBe(true);
    expect(employerNameMatches("AcmeBankChase", "AcmeBank")).toBe(true);
    expect(employerNameMatches("Allen & Example LLP", "Allen & Example")).toBe(true);
    expect(employerNameMatches("Acmeco Holdings", "Acm")).toBe(false);
    expect(employerNameMatches("Bigacme Corp", "Acme Corp")).toBe(false);
  });

  it("G07: lifts explicit office days in the description; G07B: unknown work mode still needs verification", () => {
    expectFixture(ONSITE_FIXTURES.G07);
    expectFixture(ONSITE_FIXTURES.G07B);
  });

  it("G08: does not lift other gates such as travel", () => {
    expectFixture(ONSITE_FIXTURES.G08);
  });

  it("does not treat 'data scientist' as a research title", () => {
    expect(findOnsiteException({ title: "Lead Data Scientist", company_name: "Synthetic Retail" }, basePolicy)).toBeNull();
    expect(findOnsiteException({ title: "Scientist, Computational Biology", company_name: "Synthetic Bio" }, basePolicy)?.kind).toBe("RESEARCH_ROLE");
  });

  it("lifts persisted OFFICE_DAYS and WORK_MODE requirements for an exception and records evidence", () => {
    const job = {
      title: "Research Associate (AI for Medicine)",
      company_name: "National University of Singapore",
      workplace_type: "ONSITE",
      location: "Singapore",
      posted_at: new Date().toISOString(),
      description: "Full-time. Develop machine learning models for clinical research.",
    };
    const requirements = [
      { requirement_key: "R1", requirement_type: "OFFICE_DAYS", requirement_text: "5 days per week on-site", quote_text: "5 days per week on-site", structured_value: { office_days_per_week: 5 } },
      { requirement_key: "R2", requirement_type: "WORK_MODE", requirement_text: "Fully on-site", quote_text: "Fully on-site", structured_value: null },
    ];
    const excepted = applyPersistedRequirementGates(job, requirements, basePolicy);
    expect(excepted.status).toBe("PASS");
    expect(excepted.evidence_quotes.join(" ")).toMatch(/ON-SITE EXCEPTION \(RESEARCH_ROLE\)/);

    const commercial = applyPersistedRequirementGates({ ...job, title: "AI Engineer", company_name: "Synthetic Retail" }, requirements, basePolicy);
    expect(commercial.status).toBe("HARD_REJECT");
    expect(commercial.rejection_codes).toEqual(["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"]);
  });

  it("accepts the optional stage3 field and keeps the policy hash when it is absent", () => {
    expect(Stage3WorkPreferencesSchema.parse({}).mobility.onsite_exception_employers).toBeUndefined();
    const parsed = Stage3WorkPreferencesSchema.parse({ mobility: { onsite_exception_employers: ["Northwind Markets"] } });
    expect(parsed.mobility.onsite_exception_employers).toEqual(["Northwind Markets"]);
    expect(() => Stage3WorkPreferencesSchema.parse({ mobility: { onsite_exception_employers: [""] } })).toThrow();

    const resolution = { policy: basePolicy, policyHash: "a".repeat(64), source: "FILE" as const };
    expect(resolveOnsiteExceptionPolicy(resolution, {})).toBe(resolution);
    expect(resolveOnsiteExceptionPolicy(resolution, { mobility: {} })).toBe(resolution);
    const withList = resolveOnsiteExceptionPolicy(resolution, parsed);
    expect(withList.policy.onsiteExceptionEmployers).toEqual(["Northwind Markets"]);
    expect(withList.policyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(withList.policyHash).not.toBe(resolution.policyHash);
  });
});

describe("Gate policy 2026-11 — rule 2: function and domain are not hard gates", () => {
  it.each(Object.values(FUNCTION_DOMAIN_FIXTURES))("$id: $notes", (fixture) => {
    expectFixture(fixture);
  });

  it("does not emit NON_TECHNICAL_FUNCTION from the persisted requirement gates", () => {
    const result = applyPersistedRequirementGates({
      title: "Lead Product Manager (Legal Services)",
      company_name: "Synthetic Government Technology Agency",
      workplace_type: "HYBRID",
      location: "Singapore",
      posted_at: new Date().toISOString(),
      description: "Prioritise the roadmap with policy owners.",
    }, [], basePolicy);
    expect(result.status).toBe("PASS");
    expect(result.rejection_codes).not.toContain("NON_TECHNICAL_FUNCTION");
    expect(result.rejection_codes).not.toContain("GATE_OUT_OF_SCOPE_DOMAIN");
  });
});

describe("Gate policy 2026-11 — rule 3: territory false positives", () => {
  it.each(Object.values(TERRITORY_FIXTURES))("$id: $notes", (fixture) => {
    expectFixture(fixture);
  });

  it("reads a remote hiring list that includes Southeast Asia/APAC as including Singapore", () => {
    const scope = remoteTerritoryScopeForPolicy(basePolicy);
    expect(scope).not.toBeNull();
    const listed = applyRemoteTerritoryGate({
      sourceName: "LINKEDIN_SAVED",
      location: "Singapore (Remote)",
      workplaceType: "REMOTE",
      description: REMOTE_LIST_DESCRIPTION,
    }, scope);
    expect(listed.status).toBe("PASS");
    expect(listed.rejection_codes).not.toContain("GATE_REMOTE_TERRITORY_RESTRICTED");

    const usOnly = applyRemoteTerritoryGate({
      sourceName: "LINKEDIN_SAVED",
      location: "Remote",
      workplaceType: "REMOTE",
      description: "LOCATION: Remote - US.\nBuild bioinformatics pipelines in Python.",
    }, scope);
    expect(usOnly.status).toBe("HARD_REJECT");
    expect(usOnly.rejection_codes).toContain("GATE_REMOTE_TERRITORY_RESTRICTED");
  });

  it("treats Southeast Asia and APAC as regions that contain Singapore", () => {
    expect(isTerritoryAuthorized("SOUTHEAST_ASIA", ["SINGAPORE"])).toBe(true);
    expect(isTerritoryAuthorized("ASIA_PACIFIC", ["SINGAPORE"])).toBe(true);
    expect(isTerritoryAuthorized("MALAYSIA", ["SINGAPORE"])).toBe(false);
    const requirements = extractExplicitWorkerTerritoryRequirements("Candidates must be based in Southeast Asia.");
    expect(evaluateWorkerTerritoryRequirements(requirements, ["SINGAPORE"]).status).toBe("ALLOWED");
  });

  it("keeps an explicit citizenship requirement inside an export-control sentence", () => {
    const requirements = extractExplicitWorkerTerritoryRequirements("Due to U.S. export control regulations, applicants must be U.S. citizens.");
    expect(evaluateWorkerTerritoryRequirements(requirements, ["SINGAPORE"]).status).toBe("INCOMPATIBLE");
  });

  it("reads a 'based in' list in the mobility gate as alternatives", () => {
    const mobility = { employment_home_base: "Singapore", requires_residency_in_home_base: true };
    const listed = evaluateMobilityMatch({
      workplace_type: "REMOTE",
      location: "Singapore (Remote)",
      description: "Location: based in Australia/Singapore/South Korea/Taiwan.",
    }, mobility);
    expect(listed.is_hard_reject).toBe(false);
    const foreign = evaluateMobilityMatch({
      workplace_type: "HYBRID",
      location: "Kuala Lumpur (Hybrid)",
      description: "This is a manager-level role based in Malaysia.",
    }, mobility);
    expect(foreign.is_hard_reject).toBe(true);
  });
});

describe("Gate policy 2026-11 — rule 4: precise lifestyle codes", () => {
  it.each(Object.values(LIFESTYLE_FIXTURES))("$id: $notes", (fixture) => {
    expectFixture(fixture);
  });

  it("applies the configured travel limit and names it in the evidence", () => {
    const tenPercent = { ...basePolicy, maxTravelPct: 10 };
    const fifteen = gate({ ...LIFESTYLE_FIXTURES.G21, raw_description: "Build data pipelines in Python. Travel up to 15% is expected." }, tenPercent);
    expect(fifteen.status).toBe("HARD_REJECT");
    expect(fifteen.rejection_codes).toEqual(["GATE_TRAVEL_ABOVE_LIMIT"]);
    expect(fifteen.evidence_quotes[0]).toBe("Travel above 10%: the posting states up to 15%");
    const ten = gate({ ...LIFESTYLE_FIXTURES.G21, raw_description: "Build data pipelines in Python. Travel up to 10% is expected." }, tenPercent);
    expect(ten.status).toBe("PASS");
    // A literal "up to 25% travel" phrase within a higher limit is not a conflict.
    const generous = gate({ ...LIFESTYLE_FIXTURES.G21, raw_description: "Build data pipelines in Python. Up to 25% travel." }, { ...basePolicy, maxTravelPct: 30 });
    expect(generous.rejection_codes).not.toContain("GATE_TRAVEL_ABOVE_LIMIT");
  });

  it("emits precise codes from persisted TRAVEL, ON_CALL and SHIFT_WORK requirements", () => {
    const job = {
      title: "Machine Learning Engineer",
      company_name: "Synthetic Systems",
      workplace_type: "REMOTE",
      location: "Singapore",
      posted_at: new Date().toISOString(),
      description: "Build machine learning services in Python.",
    };
    const requirement = (type: string, text: string) => ({ requirement_key: type, requirement_type: type, requirement_text: text, quote_text: text, structured_value: null });
    expect(applyPersistedRequirementGates(job, [requirement("TRAVEL", "Travel up to 50%")], basePolicy).rejection_codes).toEqual(["GATE_TRAVEL_ABOVE_LIMIT"]);
    expect(applyPersistedRequirementGates(job, [requirement("ON_CALL", "on-call rotation")], basePolicy).rejection_codes).toEqual(["GATE_ON_CALL_REQUIRED"]);
    expect(applyPersistedRequirementGates(job, [requirement("SHIFT_WORK", "rotating night shifts")], basePolicy).rejection_codes).toEqual(["GATE_SHIFT_WORK_REQUIRED"]);
  });

  it("keeps legacy GATE_LIFESTYLE_INCOMPATIBLE rows readable, labelled and valid", () => {
    expect(LIFESTYLE_GATE_CODES).toContain("GATE_LIFESTYLE_INCOMPATIBLE");
    expect(gateReasonLabel("GATE_LIFESTYLE_INCOMPATIBLE")).toMatch(/legacy/i);
    expect(gateReasonLabel("GATE_TRAVEL_ABOVE_LIMIT")).toBe("Travel above the accepted limit");
    expect(gateReasonLabel("SOME_FUTURE_CODE")).toBe("SOME_FUTURE_CODE");
    for (const code of ["GATE_TRAVEL_ABOVE_LIMIT", "GATE_ON_CALL_REQUIRED", "GATE_SHIFT_WORK_REQUIRED", "GATE_JOB_LOCATION_MISMATCH"]) {
      expect(GATE_REASON_LABELS[code]).toBeTruthy();
    }
    for (const codes of [["GATE_LIFESTYLE_INCOMPATIBLE"], ["GATE_TRAVEL_ABOVE_LIMIT"], ["GATE_ON_CALL_REQUIRED"]]) {
      expect(() => PersistedGateDecisionSchema.parse({
        schema_version: GATE_VERSION,
        canonical_job_id: "00000000-0000-4000-8000-000000000001",
        job_version_id: "00000000-0000-4000-8000-000000000002",
        pipeline_run_id: "00000000-0000-4000-8000-000000000003",
        gate_version: GATE_VERSION,
        workability_policy_hash: "b".repeat(64),
        status: "HARD_REJECT",
        rejection_codes: codes,
        evidence_quotes: ["synthetic evidence"],
        workability_facts: { office_days_min: null, office_days_max: null, travel_pct_max: 50, employment_type: "UNKNOWN", location_restriction: null },
        evaluated_at: new Date().toISOString(),
      })).not.toThrow();
    }
  });

  it("detects negated lifestyle false negatives for legacy and new codes", () => {
    for (const code of ["GATE_LIFESTYLE_INCOMPATIBLE", "GATE_ON_CALL_REQUIRED", "GATE_TRAVEL_ABOVE_LIMIT"]) {
      expect(classifyRepairCategory({
        processing_state: "HARD_REJECTED",
        gate_decision: "HARD_REJECT",
        primary_lane: null,
        rejection_reason: code,
        rejection_reason_codes: [code],
        evidence_quotes: ["There is no on-call rotation for this role."],
      })).toBe("FALSE_NEGATIVE_NEGATED_LIFESTYLE");
    }
  });
});

describe("Gate policy 2026-11 — rule 5: unchanged gates", () => {
  it.each(Object.values(UNCHANGED_FIXTURES))("$id: $notes", (fixture) => {
    expectFixture(fixture);
  });

  it("keeps the excluded-employer gate", () => {
    const result = applyPersistedRequirementGates({
      title: "Senior Data Engineer",
      company_name: "Synthetic Excluded Insurer",
      posted_at: new Date().toISOString(),
      description: "Build data pipelines in Python.",
    }, [], basePolicy, null, { watchlist: { excluded_employers: ["Synthetic Excluded Insurer"] } });
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_EXCLUDED_EMPLOYER");
  });
});
