import { describe, expect, it } from "vitest";

import { JobConfirmedFactRequestSchema, isSafeSourceUrl } from "../../contracts/jobConfirmedFacts.js";
import { assessWorkModeReadiness } from "../../eligibility/workabilityReadiness.js";
import {
  applyConfirmedFactsToGateInput,
  confirmedEmploymentType,
  confirmedFactEvidenceQuote,
  confirmedJobFactsHash,
  confirmedTravelEvidence,
  confirmedWorkModeEvidence,
  parseConfirmedFactRow,
  withConfirmedFactEvidence,
  withConfirmedTerritory,
  type ConfirmedJobFact,
  type GateRequirementRow,
} from "../../pipeline/confirmedJobFacts.js";
import { applyPersistedRequirementGates } from "../../pipeline/hardGate.js";
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

function fact(row: { id: string; fact_type: string; fact_value: Record<string, unknown>; source_type?: string }): ConfirmedJobFact {
  return parseConfirmedFactRow({
    confirmed_fact_id: row.id,
    fact_type: row.fact_type,
    fact_value: row.fact_value,
    source_type: row.source_type ?? "RECRUITER_EMAIL",
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
const NO_ON_CALL = fact({ id: "a1000000-0000-4000-8000-000000000008", fact_type: "ON_CALL", fact_value: { on_call_required: false } });
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

  it("accepts only credential-free http(s) source URLs", () => {
    expect(isSafeSourceUrl("https://careers.example.test/role?id=1")).toBe(true);
    expect(isSafeSourceUrl("http://example.test")).toBe(true);
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

  it("rejects a stored row whose value does not match its type", () => {
    expect(() => parseConfirmedFactRow({
      confirmed_fact_id: "a1000000-0000-4000-8000-0000000000ff",
      fact_type: "TRAVEL_PCT",
      fact_value: { work_mode: "HYBRID" },
      source_type: "OTHER",
      recorded_at: "2026-11-10T09:00:00.000Z",
    })).toThrow(/invalid TRAVEL_PCT value/);
  });
});

describe("confirmed facts as gate input", () => {
  it("fills an unknown or assumed work mode and records the evidence quote", () => {
    for (const workplaceType of ["UNKNOWN", "", "ASSUMED_HYBRID", null]) {
      const merged = applyConfirmedFactsToGateInput(gateInput({ workplaceType }), [], [HYBRID]);
      expect(merged.workplaceType).toBe("HYBRID");
      expect(merged.applied).toEqual([HYBRID]);
      expect(merged.requirements).toHaveLength(1);
      expect(merged.requirements[0]).toMatchObject({ requirement_type: "WORK_MODE", quote_text: "User-confirmed (source: recruiter email): work mode is hybrid" });
    }
  });

  it("never replaces a work mode the posting states", () => {
    for (const workplaceType of ["REMOTE", "HYBRID", "ONSITE"]) {
      const merged = applyConfirmedFactsToGateInput(gateInput({ workplaceType }), [], [ONSITE]);
      expect(merged.workplaceType).toBe(workplaceType);
      expect(merged.applied).toEqual([]);
    }
    const stated = [requirement("WORK_MODE", "This is a remote role")];
    const merged = applyConfirmedFactsToGateInput(gateInput({ workplaceType: "UNKNOWN" }), stated, [ONSITE]);
    expect(merged.workplaceType).toBe("UNKNOWN");
    expect(merged.requirements).toEqual(stated);
  });

  it("fills unknown office days and travel, replacing only unknown-valued requirement rows", () => {
    const unknownOffice = requirement("OFFICE_DAYS", "Some office attendance is expected");
    const merged = applyConfirmedFactsToGateInput(gateInput(), [unknownOffice], [OFFICE_2_3, TRAVEL_10]);
    expect(merged.applied.map((item) => item.factType)).toEqual(["OFFICE_DAYS", "TRAVEL_PCT"]);
    expect(merged.requirements.find((row) => row.requirement_type === "OFFICE_DAYS")?.structured_value)
      .toMatchObject({ office_days_per_week: 3, office_days_min: 2, office_days_max: 3 });
    expect(merged.requirements.find((row) => row.requirement_type === "TRAVEL")?.structured_value)
      .toMatchObject({ max_travel_pct: 10 });

    const statedOffice = requirement("OFFICE_DAYS", "2 days per week in the office");
    const kept = applyConfirmedFactsToGateInput(gateInput({ description: `${DESCRIPTION} Travel up to 5% per year.` }), [statedOffice], [OFFICE_4, TRAVEL_40]);
    expect(kept.applied).toEqual([]);
    expect(kept.requirements).toEqual([statedOffice]);
  });

  it("adds a required on-call, ignores 'no on-call', and fills an unknown employment type and location", () => {
    const merged = applyConfirmedFactsToGateInput(
      gateInput({ location: "Asia Pacific", sourceLocation: null }),
      [],
      [ON_CALL, PERMANENT, SINGAPORE],
    );
    expect(merged.requirements.map((row) => row.requirement_type)).toEqual(["ON_CALL"]);
    expect(merged.employmentType).toBe("PERMANENT");
    expect(merged.location).toBe("Singapore");
    expect(merged.sourceLocation).toBe("Singapore");
    expect(merged.applied.map((item) => item.factType)).toEqual(["ON_CALL", "EMPLOYMENT_TYPE", "LOCATION"]);

    const quiet = applyConfirmedFactsToGateInput(gateInput({ employmentType: "Full-time" }), [], [NO_ON_CALL, PERMANENT, SINGAPORE]);
    expect(quiet.applied).toEqual([]);
    expect(quiet.employmentType).toBe("Full-time");
  });

  it("lets a confirmed on-site role without an exception hard-reject with user-confirmed evidence", () => {
    const merged = applyConfirmedFactsToGateInput(gateInput(), [], [ONSITE]);
    const globalResult = applyGlobalGates({
      id: "synthetic",
      title: TITLE,
      company_name: "Synthetic Fixture Co",
      source: "canonical",
      raw_description: DESCRIPTION,
      location: merged.location ?? "",
      workplace_type: merged.workplaceType ?? "",
      employment_type: merged.employmentType ?? "",
    } as any, POLICY);
    expect(globalResult.status).toBe("HARD_REJECT");
    const persisted = applyPersistedRequirementGates(
      { title: TITLE, company_name: "Synthetic Fixture Co", workplace_type: merged.workplaceType ?? undefined, description: DESCRIPTION },
      merged.requirements,
      POLICY,
    );
    expect(persisted.status).toBe("HARD_REJECT");
    expect(persisted.evidence_quotes).toContain("User-confirmed (source: hiring manager): work mode is on-site only");
    const combined = withConfirmedFactEvidence(globalResult, merged.applied);
    expect(combined.evidence_quotes).toContain(confirmedFactEvidenceQuote(ONSITE));
    expect(combined.rejection_codes).toContain("GATE_HIGH_OFFICE_DAYS");
  });

  it("passes a confirmed hybrid role in an authorized territory and rejects confirmed four office days", () => {
    const merged = applyConfirmedFactsToGateInput(gateInput(), [], [HYBRID]);
    const result = applyGlobalGates({
      id: "synthetic",
      title: TITLE,
      company_name: "Synthetic Fixture Co",
      source: "canonical",
      raw_description: DESCRIPTION,
      location: merged.location ?? "",
      workplace_type: merged.workplaceType ?? "",
    } as any, POLICY);
    expect(result.status).toBe("PASS");
    expect(result.rejection_codes).not.toContain("GATE_UNKNOWN_WORK_MODE");

    const fourDays = applyConfirmedFactsToGateInput(gateInput(), [], [HYBRID, OFFICE_4]);
    const persisted = applyPersistedRequirementGates(
      { title: TITLE, company_name: "Synthetic Fixture Co", workplace_type: fourDays.workplaceType ?? undefined, description: DESCRIPTION },
      fourDays.requirements,
      POLICY,
    );
    expect(persisted.status).toBe("HARD_REJECT");
    expect(persisted.evidence_quotes).toEqual(["User-confirmed (source: recruiter email): 4 office days per week"]);
  });

  it("does not change the gate result when nothing was applied", () => {
    const result = applyGlobalGates({ id: "x", title: TITLE, company_name: "C", source: "canonical", raw_description: DESCRIPTION, location: "Singapore", workplace_type: "REMOTE" } as any, POLICY);
    expect(withConfirmedFactEvidence(result, [])).toBe(result);
  });
});

describe("confirmed facts as readiness evidence", () => {
  const policy = POLICY;

  it("settles unverified work mode with the confirmed mode and keys the evidence", () => {
    const evidence = confirmedWorkModeEvidence(null, "ASSUMED_HYBRID", [HYBRID]);
    expect(evidence).toEqual({
      status: "SUPPORTED",
      value: "HYBRID",
      office_days_max: null,
      evidence: [{ evidence_key: `user_confirmed:WORK_MODE:${HYBRID.id}` }],
    });
    const met = assessWorkModeReadiness(evidence, "ASSUMED_HYBRID", 3, "POLICY_HYBRID_3_2", "PASS", policy);
    expect(met.status).toBe("MET");
    expect(met.evidenceKeys).toEqual([`user_confirmed:WORK_MODE:${HYBRID.id}`]);

    const onsite = assessWorkModeReadiness(confirmedWorkModeEvidence(null, "UNKNOWN", [ONSITE]), "UNKNOWN", null, null, "HARD_REJECT", policy);
    expect(onsite.status).toBe("BLOCKED");

    const unverified = assessWorkModeReadiness(confirmedWorkModeEvidence(null, "UNKNOWN", []), "UNKNOWN", null, null, "NEEDS_VERIFICATION", policy);
    expect(unverified.reasonCode).toBe("WORK_MODE_UNVERIFIED");
  });

  it("keeps supported source evidence and stated work modes", () => {
    const source = { status: "SUPPORTED", value: "REMOTE", office_days_max: 0, evidence: [{ evidence_key: "source:remote" }] };
    expect(confirmedWorkModeEvidence(source, "UNKNOWN", [ONSITE])).toBe(source);
    expect(confirmedWorkModeEvidence(null, "REMOTE", [ONSITE])).toBeNull();
  });

  it("fills travel, employment type and territory only when unknown", () => {
    expect(confirmedTravelEvidence(null, DESCRIPTION, [TRAVEL_10])).toMatchObject({ status: "SUPPORTED", maximum: 10 });
    expect(confirmedTravelEvidence(null, "Travel up to 30% to client sites.", [TRAVEL_10])).toBeNull();
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
