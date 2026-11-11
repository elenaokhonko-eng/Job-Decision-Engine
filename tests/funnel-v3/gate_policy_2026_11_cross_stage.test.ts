import { describe, expect, it } from "vitest";
import { applyGlobalGates } from "../../src/services/criteria.js";
import { applyPersistedRequirementGates } from "../../src/pipeline/hardGate.js";
import { loadWorkabilityPolicy, withOnsiteExceptionEmployers } from "../../src/pipeline/workabilityPolicy.js";
import { findOnsiteException } from "../../src/pipeline/onsiteExceptions.js";
import { assessWorkModeReadiness } from "../../src/eligibility/workabilityReadiness.js";
import { prefilterWhoIsHiringPost } from "../../src/ingestion/adapters/hackerNewsWhoIsHiringAdapter.js";
import {
  AFFECTED_CODES,
  assertApplyAllowed,
  compareApplied,
  parseReplayArgs,
  summarizeReplay,
} from "../../scripts/replay_hard_gate_policy_2026_11.js";
import { parseJobIds, summarizeSkips } from "../../scripts/regate_job_ids.js";
import { enrichWorkModeIfNeeded } from "../../src/services/workModeEnrichment.js";

const basePolicy = loadWorkabilityPolicy();
const ENGINEERING = "Build data pipelines and deploy machine learning services in Python on Kubernetes.";

function gate(title: string, company = "Synthetic Legal Systems") {
  return applyGlobalGates({
    id: `synthetic-${title}`,
    title,
    company_name: company,
    raw_description: ENGINEERING,
    location: "Singapore (Hybrid)",
    workplace_type: "HYBRID",
    employment_type: "PERMANENT",
  } as never, basePolicy);
}

describe("Gate policy 2026-11 — one exception evaluation across gate, readiness and pre-filter", () => {
  const onsiteEvidence = { status: "SUPPORTED", value: "ONSITE", office_days_max: 5, evidence: [{ evidence_key: "work_mode:onsite" }] };

  it("readiness accepts employer-confirmed on-site work when the gate's exception applies", () => {
    const exception = findOnsiteException({ title: "Research Fellow (AI)", company_name: "National University of Singapore" }, basePolicy);
    expect(exception?.kind).toBe("RESEARCH_ROLE");
    const withException = assessWorkModeReadiness(onsiteEvidence, "ONSITE", 5, "EMPLOYER_STATED", "PASS", basePolicy, exception);
    expect(withException.status).toBe("MET");
    expect(withException.evidenceKeys).toContain("onsite_exception:RESEARCH_ROLE");
    expect(withException.policyReferenceRequired).toBe(true);

    const withoutException = assessWorkModeReadiness(onsiteEvidence, "ONSITE", 5, "EMPLOYER_STATED", "PASS", basePolicy);
    expect(withoutException.status).toBe("BLOCKED");
    expect(withoutException.reasonCode).toBe("WORK_MODE_INCOMPATIBLE");
  });

  it("readiness still needs verification for an unknown work mode even with an exception", () => {
    const exception = findOnsiteException({ title: "Research Fellow (AI)", company_name: "National University of Singapore" }, basePolicy);
    expect(assessWorkModeReadiness(null, "UNKNOWN", null, null, "NEEDS_VERIFICATION", basePolicy, exception).status).toBe("NEEDS_VERIFICATION");
  });

  it("the HN pre-filter keeps an on-site posting that qualifies for an exception", () => {
    const post = {
      company: "National University of Singapore",
      title: "Research Engineer (Machine Learning)",
      locationRaw: "Singapore",
      workMode: "ONSITE" as const,
      employmentType: "Full-time",
      salaryText: null,
      applyUrl: null,
      headerLine: "National University of Singapore | Research Engineer (Machine Learning) | Singapore | ONSITE",
      attendanceQualified: false,
      description: "Build machine learning research software in Python.",
      mentionsRemoteOrHybrid: false,
    };
    expect(prefilterWhoIsHiringPost(post, basePolicy)).toBeNull();
    const commercial = { ...post, company: "Synthetic Retail Analytics", title: "Senior AI Engineer", headerLine: "Synthetic Retail Analytics | Senior AI Engineer | Singapore | ONSITE" };
    expect(prefilterWhoIsHiringPost(commercial, basePolicy)?.reasonCode).toBe("PREFILTER_ONSITE_ONLY");
    expect(prefilterWhoIsHiringPost(commercial, withOnsiteExceptionEmployers(basePolicy, ["Synthetic Retail Analytics"]))).toBeNull();
  });
});

describe("Gate policy 2026-11 — user decisions", () => {
  it.each([
    "Lawyer",
    "In-house Counsel",
    "Legal Counsel, APAC",
    "Associate Attorney",
    "General Counsel",
  ])("keeps rejecting the legal-practice title %j", (title) => {
    const result = gate(title);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_OUT_OF_SCOPE_DOMAIN");
  });

  it.each([
    "Legal Engineer",
    "Legal Innovation Technologist",
    "Legal Technology Lead",
    "Software Engineer, Attorney-General's Office",
  ])("does not reject the legal-technology title %j", (title) => {
    const result = gate(title);
    expect(result.status, JSON.stringify(result.rejection_codes)).toBe("PASS");
    expect(result.rejection_codes).toEqual([]);
  });

  it("lifts the on-site rule for a scientist only at a research employer", () => {
    const onsite = (company: string) => applyGlobalGates({
      id: "scientist",
      title: "Scientist, Computational Biology",
      company_name: company,
      raw_description: `Full-time. ${ENGINEERING}`,
      location: "Singapore (On-site)",
      workplace_type: "ONSITE",
      employment_type: "PERMANENT",
    } as never, basePolicy);
    expect(onsite("National University of Singapore").status).toBe("PASS");
    const commercial = onsite("Synthetic Biotech Pte Ltd");
    expect(commercial.status).toBe("HARD_REJECT");
    expect(commercial.rejection_codes).toEqual(expect.arrayContaining(["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"]));
  });

  it("keeps the travel limit at the configured 20% and names it in the evidence", () => {
    expect(basePolicy.maxTravelPct).toBe(20);
    const job = { title: "Machine Learning Engineer", company_name: "Synthetic Systems", workplace_type: "REMOTE", location: "Singapore", posted_at: new Date().toISOString(), description: ENGINEERING };
    const req = (text: string) => [{ requirement_key: "T", requirement_type: "TRAVEL", requirement_text: text, quote_text: text, structured_value: null }];
    const above = applyPersistedRequirementGates(job, req("Travel up to 25%"), basePolicy);
    expect(above.rejection_codes).toEqual(["GATE_TRAVEL_ABOVE_LIMIT"]);
    expect(above.evidence_quotes[0]).toBe("Travel above 20%: the posting states up to 25%");
    expect(applyPersistedRequirementGates(job, req("Travel up to 15%"), basePolicy).status).toBe("PASS");
  });
});

describe("Gate policy 2026-11 — replay script", () => {
  it("summarizes a replay into transitions, renamed codes and the ids to re-gate", () => {
    const report = summarizeReplay([
      { canonicalJobId: "a", oldDecision: "HARD_REJECT", oldCodes: ["NON_TECHNICAL_FUNCTION", "GATE_OUT_OF_SCOPE_DOMAIN"], newStatus: "PASS", newCodes: [], label: null },
      { canonicalJobId: "b", oldDecision: "HARD_REJECT", oldCodes: ["GATE_LIFESTYLE_INCOMPATIBLE"], newStatus: "HARD_REJECT", newCodes: ["GATE_TRAVEL_ABOVE_LIMIT"], label: null },
      { canonicalJobId: "c", oldDecision: "HARD_REJECT", oldCodes: ["GATE_HIGH_INTERACTION"], newStatus: "HARD_REJECT", newCodes: ["GATE_HIGH_INTERACTION"], label: null },
      { canonicalJobId: "d", oldDecision: "HARD_REJECT", oldCodes: ["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"], newStatus: "NEEDS_VERIFICATION", newCodes: ["GATE_UNKNOWN_WORK_MODE"], label: null },
      { canonicalJobId: "e", oldDecision: "PASS", oldCodes: [], newStatus: "PASS", newCodes: [], label: null },
      { canonicalJobId: "f", oldDecision: "PASS", oldCodes: [], newStatus: "HARD_REJECT", newCodes: ["GATE_TRAVEL_ABOVE_LIMIT"], label: null },
    ]);
    expect(report.transitions).toEqual({
      "HARD_REJECT -> PASS": 1,
      "HARD_REJECT -> HARD_REJECT": 2,
      "HARD_REJECT -> NEEDS_VERIFICATION": 1,
      "PASS -> PASS": 1,
      "PASS -> HARD_REJECT": 1,
    });
    expect(report.renamedOnly).toBe(1);
    expect(report.newlyRejected).toBe(1);
    expect(report.changedJobIds).toEqual(["a", "b", "d", "f"]);
    expect(AFFECTED_CODES).toContain("GATE_LIFESTYLE_INCOMPATIBLE");
  });

  it("A1: refuses --apply when any job would newly become HARD_REJECT unless the exact count is allowed", () => {
    const base = { includeNonRejected: false, idsFile: null, allowNewRejections: null };
    expect(() => assertApplyAllowed({ newlyRejected: 0 }, base)).not.toThrow();
    expect(() => assertApplyAllowed({ newlyRejected: 2 }, base)).toThrow(/would newly become HARD_REJECT/);
    expect(() => assertApplyAllowed({ newlyRejected: 2 }, { ...base, allowNewRejections: 1 })).toThrow();
    expect(() => assertApplyAllowed({ newlyRejected: 2 }, { ...base, allowNewRejections: 2 })).not.toThrow();
    expect(() => assertApplyAllowed({ newlyRejected: 0 }, { ...base, allowNewRejections: 3 })).toThrow(/does not match/);
    // --include-non-rejected and --ids-file always need the explicit guard, even at 0.
    expect(() => assertApplyAllowed({ newlyRejected: 0 }, { ...base, includeNonRejected: true })).toThrow(/require --allow-new-rejections/);
    expect(() => assertApplyAllowed({ newlyRejected: 0 }, { ...base, includeNonRejected: true, allowNewRejections: 0 })).not.toThrow();
    expect(() => assertApplyAllowed({ newlyRejected: 0 }, { ...base, idsFile: "ids.txt" })).toThrow(/require --allow-new-rejections/);
  });

  it("A2/A3: compares applied decisions with the dry run and counts applied new rejections", () => {
    const rows = [
      { canonicalJobId: "a", oldDecision: "HARD_REJECT" as const, oldCodes: ["GATE_NOT_AI_DATA"], newStatus: "PASS" as const, newCodes: [], label: null },
      { canonicalJobId: "b", oldDecision: "PASS" as const, oldCodes: [], newStatus: "PASS" as const, newCodes: [], label: null },
      { canonicalJobId: "c", oldDecision: "HARD_REJECT" as const, oldCodes: ["GATE_LIFESTYLE_INCOMPATIBLE"], newStatus: "HARD_REJECT" as const, newCodes: ["GATE_TRAVEL_ABOVE_LIMIT"], label: null },
    ];
    const applied = new Map([
      ["a", { decision: "PASS" as const, codes: [] }],
      ["b", { decision: "HARD_REJECT" as const, codes: ["GATE_HIGH_OFFICE_DAYS"] }],
    ]);
    const comparison = compareApplied(rows, applied);
    expect(comparison.matched).toBe(1);
    expect(comparison.differed).toHaveLength(1);
    expect(comparison.missing).toEqual(["c"]);
    expect(comparison.appliedNewlyRejected).toBe(1);
  });

  it("A4: parses an ids file strictly and summarizes skip reasons", () => {
    expect(parseJobIds("# rollback\n\n00000000-0000-4000-8000-000000000001\r\n00000000-0000-4000-8000-000000000001\n")).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(() => parseJobIds("not-a-uuid\n")).toThrow(/invalid line/);
    expect(summarizeSkips([{ id: "a", reasons: ["DESCRIPTION_NOT_COMPLETE"] }, { id: "b", reasons: ["ARCHIVED", "DESCRIPTION_NOT_COMPLETE"] }]))
      .toEqual({ DESCRIPTION_NOT_COMPLETE: 2, ARCHIVED: 1 });
  });

  it("A3: previews work-mode enrichment without writes or page fetches", async () => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql.trim().split(/\s+/)[0]!.toUpperCase());
        return { rows: [] };
      },
    };
    const fetchSpy = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; throw new Error("no network in tests"); }) as typeof fetch;
    try {
      const result = await enrichWorkModeIfNeeded(client as never, { workspaceId: "w", userId: "u" } as never, {
        canonical_job_id: "00000000-0000-4000-8000-000000000001",
        job_version_id: "00000000-0000-4000-8000-000000000002",
        canonical_url: "https://jobs.example.test/role",
        workplace_type: "UNKNOWN",
        location: "Exampleville",
        description_text: "Build data pipelines in Python.",
      }, { readOnly: true });
      expect(fetched).toBe(false);
      expect(statements.every((statement) => statement === "SELECT")).toBe(true);
      expect(result.fetch_skipped).toBe(true);
    } finally {
      globalThis.fetch = fetchSpy;
    }
  });

  it("is read-only unless --apply is passed", () => {
    expect(parseReplayArgs([])).toMatchObject({ apply: false, confirmWorkspace: null, showTitles: false, includeNonRejected: false });
    expect(parseReplayArgs(["--include-non-rejected"])).toMatchObject({ includeNonRejected: true, allHardRejected: true });
    expect(parseReplayArgs(["--ids-file=ids.txt", "--allow-new-rejections=0"])).toMatchObject({ idsFile: "ids.txt", allowNewRejections: 0 });
    expect(parseReplayArgs(["--allow-new-rejections=-1"]).allowNewRejections).toBeNull();
    expect(parseReplayArgs(["--apply", "--confirm-workspace=abc", "--source=LINKEDIN_SAVED", "--limit=5"])).toMatchObject({
      apply: true, confirmWorkspace: "abc", source: "LINKEDIN_SAVED", limit: 5,
    });
  });
});
