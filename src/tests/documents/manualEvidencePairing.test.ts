import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/agent.js", () => ({
  checkModelRegistryPreflight: vi.fn(),
  generateContentAudited: vi.fn(),
  MODEL_REGISTRY: { EXTRACTION_GEMINI_MODEL: "extraction-model" },
}));

import { generateContentAudited } from "../../services/agent.js";
import { assertNoInternalAssessmentText, isSelfDescriptionStatement } from "../../documents/manualDocumentPolicy.js";
import {
  buildPairingPrompt,
  MANUAL_PAIRING_SCHEMA_VERSION,
  pairEvidenceWithModel,
  strongestPairs,
  validatePairingPayload,
  type EvidencePair,
} from "../../documents/manualEvidencePairing.js";
import { buildControlledDocuments, buildManualComparison, planRoles, type ManualEvidence, type ManualRequirement } from "../../documents/manualPreparation.js";

const mockedGenerate = vi.mocked(generateContentAudited);

// Anonymised shape of the retest: a commodities product-lead posting against a long, varied career.
const REQUIREMENTS: ManualRequirement[] = [
  { requirement_key: "R-001", requirement_type: "FUNCTION", importance: "MUST", requirement_text: "Experience with systematic trading workflows, from signal generation to execution" },
  { requirement_key: "R-002", requirement_type: "FUNCTION", importance: "MUST", requirement_text: "Delivered portfolio management systems for an asset manager or hedge fund" },
  { requirement_key: "R-003", requirement_type: "FUNCTION", importance: "MUST", requirement_text: "Currently hands-on building cloud infrastructure on Azure" },
  { requirement_key: "R-004", requirement_type: "FUNCTION", importance: "PREFERRED", requirement_text: "Knowledge of commodity derivatives markets" },
];

const engagement = (id: string, label: string, start: string, end: string | null, type: ManualEvidence["engagement_type"] = "EMPLOYEE"): ManualEvidence => ({
  id, evidence_type: "ENGAGEMENT", label, engagement_id: id, engagement_type: type, experience_class: "PROFESSIONAL_PRODUCTION",
  start_date: start, ...(end ? { end_date: end } : {}), statement: `${label} (${start}–${end ?? "present"}). Role summary.`,
});
const fact = (id: string, engagementId: string | undefined, statement: string, factType = "ACHIEVEMENT"): ManualEvidence => ({
  id, evidence_type: "FACT", label: id, statement, fact_type: factType, ...(engagementId ? { engagement_id: engagementId } : {}),
});
const credential = (id: string, name: string, type: NonNullable<ManualEvidence["credential_type"]>, pinned = false): ManualEvidence => ({
  id, evidence_type: "CREDENTIAL", label: name, credential_type: type, statement: `${name}, ${type.toLowerCase()} issued by Issuer; status ACTIVE.`,
  ...(pinned ? { always_include: true } : {}),
});

const EVIDENCE: ManualEvidence[] = [
  engagement("e-insurer", "Program Lead at Insurer Investment Management", "2023-04-01", "2025-04-30"),
  engagement("e-boutique", "Associate Director at Boutique Asset Manager", "2019-07-01", "2022-12-31"),
  engagement("e-research", "Lead Researcher at Consultancy", "2017-08-01", "2018-01-31", "RESEARCHER"),
  engagement("e-fmcg", "CRM Architect at Consumer Goods Company", "2012-02-01", "2017-09-30"),
  fact("f-liquidity", "e-insurer", "Centralized liquidity management across 10 entities and reduced payment differentials by 300 basis points."),
  fact("f-collateral", "e-insurer", "Centralized collateral custody and outsourced margining workflows to a custodian.", "RESPONSIBILITY"),
  fact("f-tom", "e-insurer", "Designed the target operating model and integration architecture for a $25B derivatives portfolio across portfolio management and trading platforms."),
  fact("f-oms", "e-boutique", "Integrated an order-management system across 3 custodians, automating transaction-level checks."),
  fact("f-research-audit", "e-research", "Audited execution logic across 20 digital wealth platforms."),
  fact("f-research-ranking", "e-research", "Developed a ranking system for suitability algorithms."),
  fact("f-crm-duty", "e-fmcg", "Owned regional sales force automation workflows and change requests.", "RESPONSIBILITY"),
  fact("f-crm", "e-fmcg", "Codified standardized retail workflows into Salesforce for 1,300 users across 16 markets."),
  fact("f-capability", "e-insurer", "Strong hands-on application architecture capability, designing modular backends.", "SKILL"),
  fact("f-cloud-knowledge", undefined, "Conceptual and developing cloud architecture knowledge across GCP and AWS; actively pursuing Google Cloud Architect certification.", "SKILL"),
  fact("f-overview", undefined, "Has 15 years of investment technology delivery experience.", "SKILL"),
  credential("c-msc", "Master of Science in Wealth Management", "DEGREE"),
  credential("c-cfa", "Passed Level I of the CFA Program", "COURSE", true),
  credential("c-health", "HI Health Insurance Certification", "CERTIFICATION"),
  credential("c-advisory", "M5 Rules and Regulations for Financial Advisory Services", "LICENSE"),
];

// What the model returned in the live probe, plus weak guesses that must not survive the threshold.
const MODEL_PAIRS: EvidencePair[] = [
  { requirement_key: "R-002", evidence_id: "f-tom", confidence: 0.95, justification: "A derivatives portfolio operating model across portfolio management platforms." },
  { requirement_key: "R-002", evidence_id: "f-oms", confidence: 0.9, justification: "Order-management system delivery at an asset manager." },
  { requirement_key: "R-001", evidence_id: "f-crm", confidence: 0.35, justification: "Both mention workflows." },
  { requirement_key: "R-003", evidence_id: "f-liquidity", confidence: 0.2, justification: "Infrastructure improvements." },
];

function comparisonWith(pairing: { pairs: EvidencePair[] } | null, evidence = EVIDENCE) {
  return buildManualComparison({
    canonical_job_id: "11111111-1111-4111-8111-111111111111",
    job_version_id: "22222222-2222-4222-8222-222222222222",
    source_observation_id: "33333333-3333-4333-8333-333333333333",
    source_evidence_fingerprint: "f".repeat(64),
    job_content_hash: "a".repeat(64),
    title: "Product Lead - Systematic Commodity Trading",
    company: "Example Commodities",
    canonical_url: null,
    profile_version_id: "44444444-4444-4444-8444-444444444444",
    candidate_profile_id: "55555555-5555-4555-8555-555555555555",
    requirement_set_id: "66666666-6666-4666-8666-666666666666",
    profile_contact_fact_ids: [],
    profile_contact_fingerprint: "b".repeat(64),
    preference_context_fingerprint: "c".repeat(64),
    context_fingerprint: "d".repeat(64),
    requirements: REQUIREMENTS,
    evidence,
    suitability_warnings: [],
    pairing,
  }) as Record<string, any>;
}

const CONTACT = { full_name: "Candidate Example", phone: "+65 6000 0000" };
const AS_OF = new Date("2026-11-02T00:00:00Z");
const rowFor = (comparison: Record<string, any>, key: string) => (comparison.rows as Array<any>).find((row) => row.requirement_key === key);

describe("manual evidence pairing", () => {
  beforeEach(() => {
    mockedGenerate.mockReset();
  });

  it("accepts only known requirements and evidence, and keeps pairs at or above the threshold", () => {
    expect(validatePairingPayload({ schema_version: MANUAL_PAIRING_SCHEMA_VERSION, pairs: [{ ...MODEL_PAIRS[0], evidence_id: "f-invented" }] }, REQUIREMENTS, EVIDENCE))
      .toMatchObject({ valid: false, issues: [expect.stringContaining("unknown evidence f-invented")] });
    expect(validatePairingPayload({ schema_version: MANUAL_PAIRING_SCHEMA_VERSION, pairs: [{ ...MODEL_PAIRS[0], requirement_key: "R-999" }] }, REQUIREMENTS, EVIDENCE))
      .toMatchObject({ valid: false });
    const kept = strongestPairs([...MODEL_PAIRS, MODEL_PAIRS[0]]);
    expect(kept.map((pair) => `${pair.requirement_key}:${pair.evidence_id}`)).toEqual(["R-002:f-tom", "R-002:f-oms"]);
  });

  it("pairs the derivatives operating model with portfolio management systems and leaves retail CRM and liquidity unpaired", () => {
    const comparison = comparisonWith({ pairs: strongestPairs(MODEL_PAIRS) });
    expect(rowFor(comparison, "R-002").evidence.map((item: any) => item.id)).toEqual(["f-tom", "f-oms"]);
    expect(rowFor(comparison, "R-002").evidence[0]).toMatchObject({ confidence: 0.95, justification: expect.stringContaining("derivatives portfolio") });
    expect(rowFor(comparison, "R-001").evidence).toEqual([]);
    expect(rowFor(comparison, "R-001").gap).toContain("No direct evidence");
    expect(rowFor(comparison, "R-003").evidence).toEqual([]);
    expect(rowFor(comparison, "R-001").comparison_method).toBe("model-judged pairing; advisory evidence only");
  });

  it("never pairs retail CRM workflows with trading workflows without a model either", () => {
    const comparison = comparisonWith(null);
    expect(rowFor(comparison, "R-001").evidence.map((item: any) => item.id)).not.toContain("f-crm");
    expect(rowFor(comparison, "R-003").evidence).toEqual([]);
    expect(rowFor(comparison, "R-001").comparison_method).toBe("distinctive-term overlap; potential evidence only");
  });

  it("reports MUST coverage before approval and keeps uncovered MUSTs out of the documents", () => {
    const comparison = comparisonWith({ pairs: strongestPairs(MODEL_PAIRS) });
    expect(comparison.fit).toMatchObject({ must_total: 3, must_covered: 1, verdict: "FEWER_THAN_HALF_MUSTS_EVIDENCED" });
    expect(comparison.fit.uncovered_must.map((item: any) => item.requirement_key)).toEqual(["R-001", "R-003"]);
    const docs = buildControlledDocuments(comparison, CONTACT, { asOf: AS_OF, includeMatchSection: true });
    expect(docs.cv).toContain("- Delivered portfolio management systems for an asset manager or hedge fund: Designed the target operating model");
    for (const text of [docs.cv, docs.coverLetter]) {
      expect(text).not.toContain("systematic trading workflows");
      expect(text).not.toContain("cloud infrastructure");
      expect(text).not.toContain("retail workflows into Salesforce for 1,300 users across 16 markets.\n- Experience");
    }
  });

  it("prints only work done: no capability or self-description statements anywhere", () => {
    expect(isSelfDescriptionStatement("Strong hands-on application architecture capability, designing modular backends.")).toBe(true);
    expect(isSelfDescriptionStatement("Conceptual and developing cloud architecture knowledge.")).toBe(true);
    expect(isSelfDescriptionStatement("Designed the target operating model for a derivatives portfolio.")).toBe(false);
    const docs = buildControlledDocuments(comparisonWith({ pairs: strongestPairs(MODEL_PAIRS) }), CONTACT, { asOf: AS_OF });
    for (const text of [docs.cv, docs.coverLetter]) {
      expect(text).not.toMatch(/conceptual and developing|actively pursuing|Strong hands-on/i);
    }
    expect(() => assertNoInternalAssessmentText("The CV", "Conceptual and developing cloud knowledge")).toThrow(/internal assessment/);
  });

  it("gives long employment a full entry and a five-month engagement one line", () => {
    const plan = new Map(planRoles(comparisonWith(null), { asOf: AS_OF }).map((role) => [role.engagement_id, role.default_layout]));
    expect(plan.get("e-fmcg")).toBe("FULL");
    expect(plan.get("e-research")).toBe("ONE_LINE");
    const docs = buildControlledDocuments(comparisonWith(null), CONTACT, { asOf: AS_OF });
    expect(docs.cv).toContain("### CRM Architect at Consumer Goods Company | Feb 2012 – Sep 2017");
    expect(docs.cv).not.toContain("### Lead Researcher at Consultancy");
    expect(docs.cv).toContain("- Lead Researcher at Consultancy (Aug 2017 – Jan 2018)");
  });

  it("fills unmatched roles with their highest-impact achievements, not file order", () => {
    const docs = buildControlledDocuments(comparisonWith({ pairs: [] }), CONTACT, { asOf: AS_OF });
    const fmcg = docs.cv.indexOf("### CRM Architect at Consumer Goods Company");
    const section = docs.cv.slice(fmcg, docs.cv.indexOf("\n\n", fmcg));
    // The quantified achievement leads; the earlier-listed unquantified duty follows.
    expect(section.indexOf("Codified standardized retail workflows")).toBeLessThan(section.indexOf("Owned regional sales force automation"));
    const insurer = docs.cv.slice(docs.cv.indexOf("### Program Lead at Insurer Investment Management"));
    expect(insurer.indexOf("$25B derivatives portfolio")).toBeLessThan(insurer.indexOf("collateral custody") === -1 ? Infinity : insurer.indexOf("collateral custody"));
  });

  it("lists pinned and relevant credentials only, never unrelated insurance or advisory licences", () => {
    const docs = buildControlledDocuments(comparisonWith({ pairs: strongestPairs(MODEL_PAIRS) }), CONTACT, { asOf: AS_OF });
    expect(docs.cv).toContain("- Passed Level I of the CFA Program");
    expect(docs.cv).not.toContain("Health Insurance");
    expect(docs.cv).not.toContain("M5 Rules");
    expect(docs.cv).toContain("## Education\n- Master of Science in Wealth Management");
  });

  it("asks the model to pair on substance and validates its answer", async () => {
    const input = { title: "Product Lead", company: "Example Commodities", requirements: REQUIREMENTS, evidence: EVIDENCE.filter((item) => item.evidence_type !== "ENGAGEMENT"), roleLabels: { "e-fmcg": "CRM Architect at Consumer Goods Company" } };
    const prompt = buildPairingPrompt(input);
    expect(prompt).toContain("Pair on substance, not shared words");
    expect(prompt).toContain("[f-crm] (FACT, CRM Architect at Consumer Goods Company) Codified standardized retail workflows");
    mockedGenerate.mockImplementation(async (options: any) => {
      const text = JSON.stringify({ schema_version: MANUAL_PAIRING_SCHEMA_VERSION, pairs: MODEL_PAIRS });
      return { text, provider: "gemini", model: "extraction-model", fallbackUsed: false, attempts: 1, errors: [], latencyMs: 1, validatedPayload: options.validateResponseText(text, {}) };
    });
    const result = await pairEvidenceWithModel(input);
    expect(mockedGenerate).toHaveBeenCalledWith(expect.objectContaining({ purpose: "EXTRACTION", routeKey: "manual_evidence_pairing" }));
    expect(result.pairs.map((pair) => pair.evidence_id)).toEqual(["f-tom", "f-oms"]);
  });
});
