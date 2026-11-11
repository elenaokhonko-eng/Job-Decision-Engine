import { describe, expect, it } from "vitest";

import { JobConfirmedFactRequestSchema, isSafeSourceUrl, normalizeSourceUrl } from "../../contracts/jobConfirmedFacts.js";
import { assessWorkModeReadiness } from "../../eligibility/workabilityReadiness.js";
import {
  applyConfirmedFactsToGateInput,
  confirmedEmploymentType,
  confirmedFactEvidenceQuote,
  confirmedJobFactsHash,
  confirmedTravelEvidence,
  confirmedWorkModeEvidence,
  gateAppliedConfirmedFacts,
  parseConfirmedFactRow,
  withConfirmedFactEvidence,
  withConfirmedTerritory,
  type ConfirmedJobFact,
  type GateRequirementRow,
} from "../../pipeline/confirmedJobFacts.js";
import { applyPersistedRequirementGates } from "../../pipeline/hardGate.js";
import { assessConfirmedValue, assessPostingFacts } from "../../pipeline/postingStatedFacts.js";
import { loadWorkabilityPolicy } from "../../pipeline/workabilityPolicy.js";
import { storedFactValue } from "../../services/jobConfirmedFactService.js";
import { applyGlobalGates } from "../../services/criteria.js";

// Synthetic identifiers and job text only.
const JOB_VERSION_ID = "6f1e2d3c-4b5a-4968-8776-655443322110";

function request(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    job_version_id: JOB_VERSION_ID,
    fact_type: "WORK_MODE",
    value: { work_mode: "HYBRID" },
    source_type: "RECRUITER_EMAIL",
    ...overrides,
  };
}

function fact(row: {
  id: string;
  fact_type: string;
  fact_value: Record<string, unknown>;
  source_type?: string;
  posting_assessment?: string;
}): ConfirmedJobFact {
  return parseConfirmedFactRow({
    confirmed_fact_id: row.id,
    fact_type: row.fact_type,
    fact_value: row.fact_value,
    source_type: row.source_type ?? "RECRUITER_EMAIL",
    posting_assessment: row.posting_assessment ?? "FILLS_UNKNOWN",
    recorded_at: "2026-11-10T09:00:00.000Z",
  });
}

const HYBRID = fact({ id: "a1000000-0000-4000-8000-000000000001", fact_type: "WORK_MODE", fact_value: { work_mode: "HYBRID" } });
const ONSITE = fact({ id: "a1000000-0000-4000-8000-000000000002", fact_type: "WORK_MODE", fact_value: { work_mode: "ONSITE" }, source_type: "HIRING_MANAGER" });
const OFFICE_2_3 = fact({ id: "a1000000-0000-4000-8000-000000000003", fact_type: "OFFICE_DAYS", fact_value: { office_days_min: 2, office_days_max: 3 } });
const OFFICE_4 = fact({ id: "a1000000-0000-4000-8000-000000000004", fact_type: "OFFICE_DAYS", fact_value: { office_days_min: 4, office_days_max: 4 } });
const TRAVEL_10 = fact({ id: "a1000000-0000-4000-8000-000000000005", fact_type: "TRAVEL_PCT", fact_value: { travel_pct_max: 10 } });
const TRAVEL_40 = fact({ id: "a1000000-0000-4000-8000-000000000006", fact_type: "TRAVEL_PCT", fact_value: { travel_pct_max: 40 } });
const ON_CALL = fact({ id: "a1000000-0000-4000-8000-000000000007", fact_type: "ON_CALL", fact_value: { on_call_required: true } });
const PERMANENT = fact({ id: "a1000000-0000-4000-8000-000000000009", fact_type: "EMPLOYMENT_TYPE", fact_value: { employment_type: "PERMANENT" }, source_type: "RECRUITER_CALL" });
const SINGAPORE = fact({ id: "a1000000-0000-4000-8000-00000000000a", fact_type: "LOCATION", fact_value: { location: "Singapore", territories: ["SINGAPORE"] } });
const ABROAD = fact({ id: "a1000000-0000-4000-8000-00000000000b", fact_type: "LOCATION", fact_value: { location: "Berlin, Germany", territories: ["GERMANY"] } });

const TITLE = "Senior Data Platform Engineer";
const DESCRIPTION = "Build and operate production data pipelines and machine learning platform services for analytics teams.";
const POLICY = loadWorkabilityPolicy();

function gateInput(overrides: Partial<Parameters<typeof applyConfirmedFactsToGateInput>[0]> = {}) {
  return {
    workplaceType: "ASSUMED_HYBRID",
    employmentType: "UNKNOWN",
    location: "Singapore",
    sourceLocation: "Singapore",
    description: DESCRIPTION,
    ...overrides,
  };
}

function requirement(type: string, text: string, structured: Record<string, unknown> | null = null): GateRequirementRow {
  return {
    requirement_key: `${type.toLowerCase()}-1`,
    requirement_type: type,
    importance: "MUST",
    requirement_text: text,
    quote_text: text,
    structured_value: structured,
  };
}

function globalGate(merged: ReturnType<typeof applyConfirmedFactsToGateInput>, description = DESCRIPTION) {
  return applyGlobalGates({
    id: "synthetic",
    title: TITLE,
    company_name: "Synthetic Fixture Co",
    source: "canonical",
    raw_description: description,
    location: merged.location ?? "",
    workplace_type: merged.workplaceType ?? "",
    employment_type: merged.employmentType ?? "",
  } as any, POLICY);
}

describe("confirmed fact request validation", () => {
  it("accepts every fact type with a matching value and normalizes optional source fields", () => {
    const values: Array<[string, Record<string, unknown>]> = [
      ["WORK_MODE", { work_mode: "ONSITE" }],
      ["OFFICE_DAYS", { office_days_min: 2, office_days_max: 3 }],
      ["TRAVEL_PCT", { travel_pct_max: 15 }],
      ["ON_CALL", { on_call_required: false }],
      ["EMPLOYMENT_TYPE", { employment_type: "CONTRACT" }],
      ["LOCATION", { location: "Singapore" }],
    ];
    for (const [factType, value] of values) {
      const parsed = JobConfirmedFactRequestSchema.safeParse(request({ fact_type: factType, value, source_note: "  ", source_url: "" }));
      expect(parsed.success, factType).toBe(true);
      if (parsed.success) {
        expect(parsed.data.source_note).toBeNull();
        expect(parsed.data.source_url).toBeNull();
      }
    }
    const withSource = JobConfirmedFactRequestSchema.parse(request({
      source_type: "EMPLOYER_CAREERS_PAGE",
      source_note: " Careers page FAQ ",
      source_url: "https://careers.example.test/jobs/123",
    }));
    expect(withSource.source_note).toBe("Careers page FAQ");
    expect(withSource.source_url).toBe("https://careers.example.test/jobs/123");
  });

  it("rejects values that do not match the fact type or its bounds", () => {
    const invalid: Array<Record<string, unknown>> = [
      { fact_type: "WORK_MODE", value: { work_mode: "FLEXIBLE" } },
      { fact_type: "WORK_MODE", value: { office_days_min: 2, office_days_max: 3 } },
      { fact_type: "OFFICE_DAYS", value: { office_days_min: 4, office_days_max: 2 } },
      { fact_type: "OFFICE_DAYS", value: { office_days_min: 1.5, office_days_max: 2 } },
      { fact_type: "OFFICE_DAYS", value: { office_days_min: 0, office_days_max: 9 } },
      { fact_type: "TRAVEL_PCT", value: { travel_pct_max: 120 } },
      { fact_type: "TRAVEL_PCT", value: { travel_pct_max: "10" } },
      { fact_type: "ON_CALL", value: { on_call_required: "yes" } },
      { fact_type: "EMPLOYMENT_TYPE", value: { employment_type: "INTERN" } },
      { fact_type: "LOCATION", value: { location: "" } },
      { fact_type: "LOCATION", value: { location: "Singapore", territories: ["SINGAPORE"] } },
      { fact_type: "SALARY", value: { amount: 1 } },
      { source_type: "LINKEDIN" },
      { job_version_id: "not-a-uuid" },
      { source_note: "x".repeat(501) },
      { source_note: "line\u0000break" },
      { unexpected: true },
    ];
    for (const override of invalid) {
      expect(JobConfirmedFactRequestSchema.safeParse(request(override)).success, JSON.stringify(override)).toBe(false);
    }
  });

  it("accepts only credential-free http(s) source URLs and normalizes them to the stored form", () => {
    expect(isSafeSourceUrl("https://careers.example.test/role?id=1")).toBe(true);
    // Forms the database CHECK used to reject are normalized by URL.href before storage.
    expect(normalizeSourceUrl("HTTPS://Careers.Example.test/x")).toBe("https://careers.example.test/x");
    expect(normalizeSourceUrl("https://example.test?q=a@b")).toBe("https://example.test/?q=a@b");
    expect(JobConfirmedFactRequestSchema.parse(request({ source_url: "HTTPS://example.test" })).source_url).toBe("https://example.test/");
    const storedForm = /^https?:\/\/[^\s/?#@]+([/?#][^\s]*)?$/;
    for (const url of ["HTTPS://Careers.Example.test/x", "https://example.test?q=a@b", "http://example.test#frag"]) {
      expect(normalizeSourceUrl(url), url).toMatch(storedForm);
    }
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "ftp://example.test/file",
      "https://user:secret@example.test/",
      "https://example.test/has space",
      "careers.example.test/jobs",
      `https://example.test/${"a".repeat(2050)}`,
    ]) {
      expect(isSafeSourceUrl(url), url).toBe(false);
      expect(JobConfirmedFactRequestSchema.safeParse(request({ source_url: url })).success, url).toBe(false);
    }
  });

  it("stores a location with its normalized territories", () => {
    const parsed = JobConfirmedFactRequestSchema.parse(request({ fact_type: "LOCATION", value: { location: "Singapore" } }));
    expect(storedFactValue(parsed)).toEqual({ location: "Singapore", territories: ["SINGAPORE"] });
  });

  it("rejects a stored row whose value or assessment does not match", () => {
    expect(() => fact({ id: "a1000000-0000-4000-8000-0000000000ff", fact_type: "TRAVEL_PCT", fact_value: { work_mode: "HYBRID" } }))
      .toThrow(/invalid TRAVEL_PCT value/);
    expect(() => fact({ id: "a1000000-0000-4000-8000-0000000000fe", fact_type: "WORK_MODE", fact_value: { work_mode: "HYBRID" }, posting_assessment: "MAYBE" }))
      .toThrow(/posting_assessment/);
  });
});

describe("posting evidence always wins over a confirmed fact (review probes)", () => {
  it("a description stating fully remote or hybrid is not overridden by a confirmed on-site role", () => {
    for (const description of [
      "This position is fully remote within Singapore.",
      "This is a hybrid role, flexible working.",
    ]) {
      const posting = assessPostingFacts({ ...gateInput({ workplaceType: "UNKNOWN", description }), requirements: [], policy: POLICY });
      expect(posting.WORK_MODE.state, description).toBe("STATED");
      expect(posting.WORK_MODE.source).toBe("DESCRIPTION");

      const without = applyConfirmedFactsToGateInput(gateInput({ workplaceType: "UNKNOWN", description }), [], [], POLICY);
      const withOnsite = applyConfirmedFactsToGateInput(gateInput({ workplaceType: "UNKNOWN", description }), [], [ONSITE], POLICY);
      expect(withOnsite.applied).toEqual([]);
      expect(withOnsite.conflicts.map((conflict) => conflict.fact)).toEqual([ONSITE]);
      expect(withOnsite.workplaceType).toBe("UNKNOWN");
      expect(withOnsite.requirements).toEqual([]);
      const before = globalGate(without, description);
      const after = withConfirmedFactEvidence(globalGate(withOnsite, description), withOnsite);
      expect(before.status, description).toBe("PASS");
      expect(after.status, description).toBe("PASS");
      expect(after.evidence_quotes.some((quote) => quote.startsWith("User confirmation not applied (source: hiring manager): work mode is on-site only; the posting states work mode"))).toBe(true);
    }
  });

  it("a 12-month contract, an internship or a part-time posting is not turned into permanent employment", () => {
    const contract = applyConfirmedFactsToGateInput(
      gateInput({ description: `${DESCRIPTION} This is a 12 month contract role.` }), [], [PERMANENT], POLICY);
    expect(contract.applied).toEqual([]);
    expect(contract.conflicts).toHaveLength(1);
    expect(contract.conflicts[0].posting.value).toEqual({ employment_type: "CONTRACT" });
    expect(contract.employmentType).toBe("UNKNOWN");
    const gate = globalGate(contract, `${DESCRIPTION} This is a 12 month contract role.`);
    expect(gate.workability_facts.employment_type).toBe("CONTRACT");

    for (const employmentType of ["Internship", "Part-time"]) {
      const merged = applyConfirmedFactsToGateInput(gateInput({ employmentType }), [], [PERMANENT], POLICY);
      expect(merged.employmentType, employmentType).toBe(employmentType);
      expect(merged.applied).toEqual([]);
      expect(merged.conflicts).toHaveLength(1);
    }
    expect(confirmedEmploymentType("INTERNSHIP", [PERMANENT])).toEqual({ employmentType: "INTERNSHIP", fact: null });
    expect(confirmedEmploymentType("PART_TIME", [PERMANENT]).employmentType).toBe("PART_TIME");
  });

  it("conflicting source evidence is a stated conflict, never overwritten", () => {
    const posting = assessPostingFacts({
      ...gateInput({ workplaceType: "UNKNOWN" }),
      requirements: [],
      sourceEvidence: { work_mode: { status: "CONFLICTING", value: "UNKNOWN", office_days_max: null } },
      policy: POLICY,
    });
    expect(posting.WORK_MODE.state).toBe("CONFLICTING");
    expect(assessConfirmedValue("WORK_MODE", { work_mode: "HYBRID" }, posting.WORK_MODE)).toBe("CONFLICTS_WITH_POSTING");

    const conflictingSource = { status: "CONFLICTING", value: "UNKNOWN", office_days_max: null, evidence: [{ evidence_key: "source:conflict" }] };
    expect(confirmedWorkModeEvidence(conflictingSource, [HYBRID])).toBe(conflictingSource);
    const conflictingTravel = { status: "CONFLICTING", minimum: null, maximum: null, evidence: [] };
    expect(confirmedTravelEvidence(conflictingTravel, [TRAVEL_10])).toBe(conflictingTravel);
  });

  it("a fact stored as a conflict is never applied even when the posting now looks unknown", () => {
    const storedConflict = fact({
      id: "a1000000-0000-4000-8000-0000000000c1",
      fact_type: "WORK_MODE",
      fact_value: { work_mode: "ONSITE" },
      posting_assessment: "CONFLICTS_WITH_POSTING",
    });
    const merged = applyConfirmedFactsToGateInput(gateInput(), [], [storedConflict], POLICY);
    expect(merged.applied).toEqual([]);
    expect(merged.conflicts).toHaveLength(1);
    expect(merged.workplaceType).toBe("ASSUMED_HYBRID");
  });

  it("a matching confirmation is not a conflict and changes nothing", () => {
    const merged = applyConfirmedFactsToGateInput(gateInput({ workplaceType: "HYBRID" }), [], [HYBRID], POLICY);
    expect(merged.applied).toEqual([]);
    expect(merged.conflicts).toEqual([]);
  });

  it("stated office days, travel, on-call and territory win over confirmations", () => {
    const statedOffice = requirement("OFFICE_DAYS", "2 days per week in the office");
    const office = applyConfirmedFactsToGateInput(gateInput(), [statedOffice], [OFFICE_4], POLICY);
    expect(office.applied).toEqual([]);
    expect(office.requirements).toEqual([statedOffice]);
    expect(office.conflicts).toHaveLength(1);

    const travel = applyConfirmedFactsToGateInput(gateInput({ description: `${DESCRIPTION} Travel up to 5% per year.` }), [], [TRAVEL_40], POLICY);
    expect(travel.conflicts).toHaveLength(1);
    const frequent = applyConfirmedFactsToGateInput(gateInput({ description: `${DESCRIPTION} Frequent travel to client sites.` }), [], [TRAVEL_10], POLICY);
    expect(frequent.conflicts).toHaveLength(1);
    const remoteOffice = applyConfirmedFactsToGateInput(gateInput({ workplaceType: "REMOTE" }), [], [OFFICE_2_3], POLICY);
    expect(remoteOffice.conflicts).toHaveLength(1);

    const location = applyConfirmedFactsToGateInput(gateInput({ location: "Singapore" }), [], [ABROAD], POLICY);
    expect(location.location).toBe("Singapore");
    expect(location.conflicts).toHaveLength(1);
  });
});

describe("the posting-stated check is never stricter than the gate (re-review probes)", () => {
  it("boilerplate words are not a stated employment type, so a confirmed permanent role applies", () => {
    for (const sentence of [
      "Smart casual dress code.",
      "We have casual Fridays.",
      "Sponsorship for a part-time MBA.",
      "You will supervise the summer intern.",
      "Work with freelance designers.",
    ]) {
      const description = `${DESCRIPTION} ${sentence}`;
      expect(globalGate(applyConfirmedFactsToGateInput(gateInput({ description }), [], [], POLICY), description)
        .workability_facts.employment_type, sentence).toBe("UNKNOWN");
      const posting = assessPostingFacts({ ...gateInput({ description }), requirements: [], policy: POLICY });
      expect(posting.EMPLOYMENT_TYPE.state, sentence).toBe("UNKNOWN");
      const merged = applyConfirmedFactsToGateInput(gateInput({ description }), [], [PERMANENT], POLICY);
      expect(merged.applied, sentence).toEqual([PERMANENT]);
      expect(merged.conflicts).toEqual([]);
      expect(globalGate(merged, description).workability_facts.employment_type).toBe("PERMANENT");
      // Readiness closes EMPLOYMENT_ROUTE with the applied fact.
      expect(confirmedEmploymentType("UNKNOWN", merged.applied)).toEqual({ employmentType: "PERMANENT", fact: PERMANENT });
    }
  });

  it("an onsite perk is not a stated work mode, so a confirmed hybrid role applies", () => {
    const description = `${DESCRIPTION} Perks: free lunch, onsite gym.`;
    const posting = assessPostingFacts({ ...gateInput({ workplaceType: "UNKNOWN", description }), requirements: [], policy: POLICY });
    expect(posting.WORK_MODE.state).toBe("UNKNOWN");
    const merged = applyConfirmedFactsToGateInput(gateInput({ workplaceType: "UNKNOWN", description }), [], [HYBRID], POLICY);
    expect(merged.applied).toEqual([HYBRID]);
    expect(globalGate(merged, description).status).toBe("PASS");
  });

  it("a bare on-call mention is not a required on-call; the gate's on-call keywords are", () => {
    const noOnCall = { on_call_required: false };
    for (const sentence of ["On-call allowance provided.", "Build tools for on-call engineers.", "Prior experience with on-call rotation is a plus."]) {
      const posting = assessPostingFacts({ ...gateInput({ description: `${DESCRIPTION} ${sentence}` }), requirements: [], policy: POLICY });
      expect(posting.ON_CALL.state, sentence).toBe("UNKNOWN");
      expect(assessConfirmedValue("ON_CALL", noOnCall, posting.ON_CALL)).toBe("FILLS_UNKNOWN");
    }
    const required = assessPostingFacts({
      ...gateInput({ description: `${DESCRIPTION} You will join a regular on-call rotation.` }),
      requirements: [],
      policy: POLICY,
    });
    expect(required.ON_CALL).toMatchObject({ state: "STATED", value: { on_call_required: true } });
    expect(assessConfirmedValue("ON_CALL", noOnCall, required.ON_CALL)).toBe("CONFLICTS_WITH_POSTING");
  });

  it("a travel phrase the gate does not read is not a stated travel percentage", () => {
    const description = `${DESCRIPTION} Work without travel restrictions.`;
    const merged = applyConfirmedFactsToGateInput(gateInput({ description }), [], [TRAVEL_10], POLICY);
    expect(merged.applied).toEqual([TRAVEL_10]);
  });

  it("the gate path reads normalized source evidence, so later SUPPORTED evidence wins over an older confirmation", () => {
    const merged = applyConfirmedFactsToGateInput(
      { ...gateInput({ workplaceType: "UNKNOWN" }), sourceEvidence: { work_mode: { status: "SUPPORTED", value: "REMOTE", office_days_max: 0 } } },
      [],
      [ONSITE],
      POLICY,
    );
    expect(merged.applied).toEqual([]);
    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0].posting).toMatchObject({ state: "STATED", source: "SOURCE_EVIDENCE", value: { work_mode: "REMOTE" } });
    expect(merged.workplaceType).toBe("UNKNOWN");
  });
});

describe("confirmed facts that fill an unknown", () => {
  it("fills an unknown or assumed work mode and records the evidence quote", () => {
    for (const workplaceType of ["UNKNOWN", "", "ASSUMED_HYBRID", null]) {
      const merged = applyConfirmedFactsToGateInput(gateInput({ workplaceType }), [], [HYBRID], POLICY);
      expect(merged.workplaceType).toBe("HYBRID");
      expect(merged.applied).toEqual([HYBRID]);
      expect(merged.requirements[0]).toMatchObject({ requirement_type: "WORK_MODE", quote_text: "User-confirmed (source: recruiter email): work mode is hybrid" });
    }
  });

  it("fills unknown office days, travel, a required on-call, employment type and location", () => {
    const merged = applyConfirmedFactsToGateInput(
      gateInput({ location: "Asia Pacific", sourceLocation: null }),
      [requirement("OFFICE_DAYS", "Some office attendance is expected")],
      [OFFICE_2_3, TRAVEL_10, ON_CALL, PERMANENT, SINGAPORE],
      POLICY,
    );
    expect(merged.applied.map((item) => item.factType).sort()).toEqual(["EMPLOYMENT_TYPE", "LOCATION", "OFFICE_DAYS", "ON_CALL", "TRAVEL_PCT"]);
    expect(merged.requirements.find((row) => row.requirement_key.startsWith("user_confirmed:office_days"))?.structured_value)
      .toMatchObject({ office_days_per_week: 3, office_days_min: 2, office_days_max: 3 });
    expect(merged.requirements.find((row) => row.requirement_type === "TRAVEL")?.structured_value).toMatchObject({ max_travel_pct: 10 });
    expect(merged.requirements.some((row) => row.requirement_type === "ON_CALL")).toBe(true);
    expect(merged.employmentType).toBe("PERMANENT");
    expect(merged.location).toBe("Singapore");
    expect(merged.sourceLocation).toBe("Singapore");
  });

  it("lets a confirmed on-site role without an exception hard-reject with user-confirmed evidence", () => {
    const merged = applyConfirmedFactsToGateInput(gateInput(), [], [ONSITE], POLICY);
    expect(globalGate(merged).status).toBe("HARD_REJECT");
    const persisted = applyPersistedRequirementGates(
      { title: TITLE, company_name: "Synthetic Fixture Co", workplace_type: merged.workplaceType ?? undefined, description: DESCRIPTION },
      merged.requirements,
      POLICY,
    );
    expect(persisted.status).toBe("HARD_REJECT");
    expect(persisted.evidence_quotes).toContain("User-confirmed (source: hiring manager): work mode is on-site only");
    const combined = withConfirmedFactEvidence(globalGate(merged), merged);
    expect(combined.evidence_quotes).toContain(confirmedFactEvidenceQuote(ONSITE));
    expect(combined.rejection_codes).toContain("GATE_HIGH_OFFICE_DAYS");
    expect(combined.workability_facts.confirmed_fact_ids).toEqual([ONSITE.id]);
  });

  it("passes a confirmed hybrid role in an authorized territory and rejects confirmed four office days", () => {
    const merged = applyConfirmedFactsToGateInput(gateInput(), [], [HYBRID], POLICY);
    const result = globalGate(merged);
    expect(result.status).toBe("PASS");
    expect(result.rejection_codes).not.toContain("GATE_UNKNOWN_WORK_MODE");

    const fourDays = applyConfirmedFactsToGateInput(gateInput(), [], [HYBRID, OFFICE_4], POLICY);
    const persisted = applyPersistedRequirementGates(
      { title: TITLE, company_name: "Synthetic Fixture Co", workplace_type: fourDays.workplaceType ?? undefined, description: DESCRIPTION },
      fourDays.requirements,
      POLICY,
    );
    expect(persisted.status).toBe("HARD_REJECT");
    expect(persisted.evidence_quotes).toEqual(["User-confirmed (source: recruiter email): 4 office days per week"]);
  });

  it("does not change the gate result when there is nothing to apply or report", () => {
    const result = applyGlobalGates({ id: "x", title: TITLE, company_name: "C", source: "canonical", raw_description: DESCRIPTION, location: "Singapore", workplace_type: "REMOTE" } as any, POLICY);
    expect(withConfirmedFactEvidence(result, { applied: [], conflicts: [] })).toBe(result);
  });
});

describe("confirmed facts as readiness evidence", () => {
  it("uses only the facts the gate applied", () => {
    const facts = [HYBRID, TRAVEL_10];
    expect(gateAppliedConfirmedFacts(facts, { confirmed_fact_ids: [HYBRID.id] })).toEqual([HYBRID]);
    expect(gateAppliedConfirmedFacts(facts, {})).toEqual([]);
  });

  it("settles unverified work mode with the applied mode and keys the evidence", () => {
    const evidence = confirmedWorkModeEvidence(null, [HYBRID]);
    expect(evidence).toEqual({
      status: "SUPPORTED",
      value: "HYBRID",
      office_days_max: null,
      evidence: [{ evidence_key: `user_confirmed:WORK_MODE:${HYBRID.id}` }],
    });
    const met = assessWorkModeReadiness(evidence, "ASSUMED_HYBRID", 3, "POLICY_HYBRID_3_2", "PASS", POLICY);
    expect(met.status).toBe("MET");
    expect(assessWorkModeReadiness(confirmedWorkModeEvidence(null, [ONSITE]), "UNKNOWN", null, null, "HARD_REJECT", POLICY).status).toBe("BLOCKED");
    const source = { status: "SUPPORTED", value: "REMOTE", office_days_max: 0, evidence: [{ evidence_key: "source:remote" }] };
    expect(confirmedWorkModeEvidence(source, [ONSITE])).toBe(source);
  });

  it("fills travel, employment type and territory only when unknown", () => {
    expect(confirmedTravelEvidence(null, [TRAVEL_10])).toMatchObject({ status: "SUPPORTED", maximum: 10 });
    expect(confirmedEmploymentType("UNKNOWN", [PERMANENT])).toEqual({ employmentType: "PERMANENT", fact: PERMANENT });
    expect(confirmedEmploymentType("CONTRACT", [PERMANENT])).toEqual({ employmentType: "CONTRACT", fact: null });

    const unknown = {
      status: "NEEDS_VERIFICATION" as const,
      reasonCode: "WORK_AUTHORIZATION_UNKNOWN",
      rationale: "Hiring-country or work-authorization evidence is unresolved.",
      evidenceKeys: [],
      policyReferenceRequired: false,
    };
    expect(withConfirmedTerritory(unknown, [SINGAPORE], ["SINGAPORE"]).status).toBe("MET");
    expect(withConfirmedTerritory(unknown, [ABROAD], ["SINGAPORE"])).toMatchObject({ status: "BLOCKED", reasonCode: "WORK_AUTHORIZATION_INCOMPATIBLE" });
    expect(withConfirmedTerritory(unknown, [], ["SINGAPORE"])).toBe(unknown);
  });

  it("hashes the facts used independently of order and returns null without facts", () => {
    expect(confirmedJobFactsHash([])).toBeNull();
    expect(confirmedJobFactsHash([HYBRID, TRAVEL_10])).toBe(confirmedJobFactsHash([TRAVEL_10, HYBRID]));
    expect(confirmedJobFactsHash([HYBRID])).not.toBe(confirmedJobFactsHash([ONSITE]));
  });
});
