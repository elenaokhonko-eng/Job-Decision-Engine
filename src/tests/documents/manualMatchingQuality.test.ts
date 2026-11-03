import { describe, expect, it } from "vitest";

import { approvedCoverLetterPairs } from "../../documents/manualCoverLetter.js";
import {
  assertNoInternalAssessmentText,
  documentRequirements,
  isSelfDescriptionStatement,
  isWorkabilityRequirement,
  postingImportance,
  type StoredRequirementRow,
} from "../../documents/manualDocumentPolicy.js";
import {
  buildControlledDocuments,
  buildManualComparison,
  evidenceAgeYears,
  matchableEvidence,
  MAX_REQUIREMENTS_PER_EVIDENCE,
  renderControlledPdf,
  winAnsiPdfText,
  type ManualEvidence,
  type ManualEvidencePairing,
  type ManualRequirement,
} from "../../documents/manualPreparation.js";

// Anonymised stand-in for a vendor market-data product owner posting: the real requirements mixed
// with location, language and travel lines, and a governance line softened only by "ideally".
const VENDOR_DATA_POSTING = [
  "What you will bring:",
  "- Experience in market data or vendor data management, data product ownership or asset management technology",
  "- Knowledge of market data vendors and delivery mechanisms such as APIs and SFTP",
  "- Data governance, data lineage, data quality and cataloguing, ideally with Unity Catalog",
  "- Experience with streaming platforms such as Kafka is a plus",
  "- Based in Frankfurt, Munich, Hong Kong or Singapore",
  "- Fluent English; German is an advantage",
  "- Willingness to travel up to 20% of the time",
  "- Valid right to work in the location of the role",
].join("\n");

const engagement = (id: string, label: string, start: string, end: string | null): ManualEvidence => ({
  id, evidence_type: "ENGAGEMENT", label, engagement_id: id, engagement_type: "EMPLOYEE", experience_class: "PROFESSIONAL_PRODUCTION",
  start_date: start, ...(end ? { end_date: end } : {}), statement: `${label} (${start}–${end ?? "present"}). Summary.`,
});
const fact = (id: string, statement: string, engagementId: string, factType = "ACHIEVEMENT"): ManualEvidence => ({
  id, evidence_type: "FACT", label: id, statement, fact_type: factType, engagement_id: engagementId,
});

const PROFILE: ManualEvidence[] = [
  engagement("eng-venture", "Founder at Venture AI", "2025-07-01", null),
  engagement("eng-aim", "Enterprise Architect at Investment Manager", "2023-04-01", "2025-04-30"),
  engagement("eng-cpg", "Regional CRM Architect at Consumer Goods Company", "2012-02-01", "2017-09-30"),
  engagement("eng-agency", "Agile Delivery Architect at Software Agency", "2008-05-01", "2009-10-31"),
  fact("f-liquidity", "Centralized liquidity management across 10 entities and reduced payment differentials by 300 basis points.", "eng-aim"),
  fact("f-aladdin", "Integrated trade, derivatives, collateral and risk data between two portfolio platforms.", "eng-aim", "PROJECT"),
  fact("f-mdm", "Architected a master data management integration layer connecting CRM, ERP and BI systems.", "eng-cpg", "TECHNOLOGY"),
  fact("f-golden", "Established golden-record master data governance across CRM, ERP and distributor systems.", "eng-cpg"),
  fact("f-venture-agile", "Runs two-week agile delivery cycles with a backlog of user stories for an AI platform.", "eng-venture", "RESPONSIBILITY"),
  fact("f-scrum", "Ran Scrum and Extreme Programming release pipelines for branded web applications.", "eng-agency", "RESPONSIBILITY"),
  fact("f-python", "Python: independently usable with AI assistance.", "eng-venture", "TECHNOLOGY"),
  fact("f-proven", "Proven capability taking a software product from idea to first production release in 6 months.", "eng-venture"),
];

function comparison(requirements: ManualRequirement[], pairs: ManualEvidencePairing["pairs"] | null, evidence = PROFILE) {
  return buildManualComparison({
    canonical_job_id: "11111111-1111-4111-8111-111111111111",
    job_version_id: "22222222-2222-4222-8222-222222222222",
    source_observation_id: "33333333-3333-4333-8333-333333333333",
    source_evidence_fingerprint: "f".repeat(64),
    job_content_hash: "a".repeat(64),
    title: "Data Product Owner - Vendor Market Data",
    company: "Example Investors",
    canonical_url: null,
    profile_version_id: "44444444-4444-4444-8444-444444444444",
    candidate_profile_id: "55555555-5555-4555-8555-555555555555",
    requirement_set_id: "66666666-6666-4666-8666-666666666666",
    profile_contact_fact_ids: [],
    profile_contact_fingerprint: "b".repeat(64),
    preference_context_fingerprint: "c".repeat(64),
    context_fingerprint: "d".repeat(64),
    requirements,
    evidence,
    suitability_warnings: [],
    pairing: pairs ? { pairs } : null,
  }) as Record<string, any>;
}

const requirement = (key: string, text: string, importance = "MUST"): ManualRequirement =>
  ({ requirement_key: key, requirement_type: "POSTING_REQUIREMENT", importance, requirement_text: text });
const pair = (requirementKey: string, evidenceId: string, confidence: number) =>
  ({ requirement_key: requirementKey, evidence_id: evidenceId, confidence, justification: "Directly demonstrates it." });
const rowEvidence = (result: Record<string, any>, key: string): string[] =>
  result.rows.find((row: { requirement_key: string }) => row.requirement_key === key).evidence.map((item: { id: string }) => item.id);

describe("manual matching quality", () => {
  it("leaves location, permit, language and travel lines out of the match table", () => {
    const texts = documentRequirements([], VENDOR_DATA_POSTING).map((row) => row.requirement_text);
    expect(texts).toEqual([
      "Experience in market data or vendor data management, data product ownership or asset management technology",
      "Knowledge of market data vendors and delivery mechanisms such as APIs and SFTP",
      "Data governance, data lineage, data quality and cataloguing, ideally with Unity Catalog",
      "Experience with streaming platforms such as Kafka is a plus",
    ]);
    // AI-quoted rows are filtered the same way.
    const quoted: StoredRequirementRow[] = [
      { requirement_key: "R-001", requirement_type: "LOCATION", importance: "MUST", requirement_text: "Based in Frankfurt, Munich, Hong Kong or Singapore", extractor_type: "LLM_QUOTED", quote_text: "Based in Frankfurt, Munich, Hong Kong or Singapore" },
      { requirement_key: "R-002", requirement_type: "LANGUAGE", importance: "MUST", requirement_text: "Business-level proficiency in written and spoken English", extractor_type: "LLM_QUOTED", quote_text: null },
    ];
    expect(documentRequirements(quoted, null)).toEqual([]);
    // Communication and data work are skills, not workability facts.
    for (const skill of ["Excellent stakeholder communication skills", "Experience with data vendors in Europe and Asia", "Travel and expense data product ownership"]) {
      expect(isWorkabilityRequirement(skill)).toBe(false);
    }
  });

  it("keeps a requirement MUST when only a trailing 'ideally' clause is optional", () => {
    expect(postingImportance("Data governance, data lineage, data quality and cataloguing, ideally with Unity Catalog")).toBe("MUST");
    expect(postingImportance("Strong SQL skills (preferably Snowflake)")).toBe("MUST");
    expect(postingImportance("Experience with streaming platforms such as Kafka is a plus")).toBe("PREFERRED");
    expect(postingImportance("Ideally, a background in derivatives clearing")).toBe("PREFERRED");
    expect(postingImportance("Nice to have: Databricks certification")).toBe("PREFERRED");
    // The extractor's PREFERRED on such a line is corrected too.
    const quoted: StoredRequirementRow[] = [{ requirement_key: "R-004", requirement_type: "SKILL", importance: "PREFERRED",
      requirement_text: "Data governance, data lineage, data quality and cataloguing, ideally with Unity Catalog", extractor_type: "LLM_QUOTED", quote_text: null }];
    expect(documentRequirements(quoted, null)[0].importance).toBe("MUST");
  });

  it("offers role-tied technology facts that record work, and never self-descriptions", () => {
    const ids = matchableEvidence(PROFILE).map((item) => item.id);
    expect(ids).toContain("f-mdm");
    expect(ids).not.toContain("f-python");
    expect(ids).not.toContain("f-proven");
    for (const statement of [
      "Proven capability taking a software product end-to-end from idea to production.",
      "Strong data architecture capability spanning relational schemas.",
      "Expert in requirements engineering for regulated platforms.",
      "Capable implementation of data ingestion pipelines.",
      "Has a proven track record of platform delivery.",
    ]) expect(isSelfDescriptionStatement(statement)).toBe(true);
    expect(isSelfDescriptionStatement("Architected a master data management integration layer.")).toBe(false);
    expect(() => assertNoInternalAssessmentText("The CV", "- Proven capability taking a product to release.")).toThrow(/internal assessment/);
  });

  it("lets one fact back at most two requirements and finds the next-best evidence for the rest", () => {
    const requirements = [
      requirement("R-1", "Data product ownership in asset management"),
      requirement("R-2", "Multi-wave roadmap, backlog and user stories"),
      requirement("R-3", "Prioritisation and stakeholder alignment", "PREFERRED"),
    ];
    const result = comparison(requirements, [
      pair("R-1", "f-liquidity", 0.9), pair("R-2", "f-liquidity", 0.85), pair("R-3", "f-liquidity", 0.8),
      pair("R-2", "f-venture-agile", 0.7), pair("R-3", "f-aladdin", 0.65),
    ]);
    const uses = result.rows.flatMap((row: { evidence: Array<{ id: string }> }) => row.evidence.map((item) => item.id))
      .filter((id: string) => id === "f-liquidity");
    expect(uses).toHaveLength(MAX_REQUIREMENTS_PER_EVIDENCE);
    // MUST requirements are served first, so the PREFERRED row gives up the reused fact.
    expect(rowEvidence(result, "R-1")).toEqual(["f-liquidity"]);
    expect(rowEvidence(result, "R-2")).toEqual(["f-liquidity", "f-venture-agile"]);
    expect(rowEvidence(result, "R-3")).toEqual(["f-aladdin"]);
  });

  it("draws a requirement's evidence from different roles before repeating one", () => {
    const evidence = [...PROFILE, fact("f-pipelines", "Established end-to-end data pipelines feeding regional BI reporting.", "eng-cpg")];
    const result = comparison([requirement("R-1", "Master data and data governance")], [
      pair("R-1", "f-golden", 0.95), pair("R-1", "f-mdm", 0.9), pair("R-1", "f-pipelines", 0.88), pair("R-1", "f-aladdin", 0.6),
    ], evidence);
    // Three strong facts from one role, but a slot goes to the other role before a third from the same one.
    expect(rowEvidence(result, "R-1")).toEqual(["f-golden", "f-mdm", "f-aladdin"]);
  });

  it("ranks recent work above old work of similar strength, measured from the profile's newest role", () => {
    const ages = evidenceAgeYears(PROFILE);
    expect(ages.get("f-scrum")).toBe(16);
    expect(ages.get("f-golden")).toBe(8);
    expect(ages.get("f-venture-agile")).toBe(0);
    const result = comparison([requirement("R-1", "Agile delivery with JIRA")], [pair("R-1", "f-scrum", 0.9), pair("R-1", "f-venture-agile", 0.8)]);
    expect(rowEvidence(result, "R-1")).toEqual(["f-venture-agile", "f-scrum"]);
    // A much stronger old match still wins: the penalty is small.
    const strongOld = comparison([requirement("R-1", "Agile delivery with JIRA")], [pair("R-1", "f-scrum", 0.95), pair("R-1", "f-venture-agile", 0.6)]);
    expect(rowEvidence(strongOld, "R-1")[0]).toBe("f-scrum");
  });

  it("orders letter pairs by importance and evidence strength, leaving out degrees and old work while newer evidence exists", () => {
    const evidence: ManualEvidence[] = [
      ...PROFILE,
      { id: "c-mba", evidence_type: "CREDENTIAL", label: "MBA", credential_type: "DEGREE", statement: "MBA, degree issued by University; status ACTIVE." },
    ];
    const result = comparison([
      requirement("R-1", "Academic background in finance or computer science"),
      requirement("R-2", "Agile delivery with JIRA"),
      requirement("R-3", "Data governance and master data"),
      requirement("R-4", "Front-to-back investment data integration"),
    ], [
      pair("R-1", "c-mba", 0.9),
      pair("R-2", "f-scrum", 0.9), pair("R-2", "f-venture-agile", 0.7),
      pair("R-3", "f-golden", 0.95),
      pair("R-4", "f-aladdin", 0.8),
    ], evidence);
    const pairs = approvedCoverLetterPairs(result);
    expect(pairs.map((item) => item.requirement_key)).toEqual(["R-3", "R-4", "R-2"]);
    // The 17-year-old Scrum fact is dropped because newer agile evidence exists.
    expect(pairs.find((item) => item.requirement_key === "R-2")!.evidence.map((item) => item.id)).toEqual(["f-venture-agile"]);
    // With nothing else to write from, the degree is used after all.
    const onlyDegree = comparison([requirement("R-1", "Academic background in finance")], [pair("R-1", "c-mba", 0.9)], evidence);
    expect(approvedCoverLetterPairs(onlyDegree).map((item) => item.requirement_key)).toEqual(["R-1"]);
  });

  it("builds the plain fallback summary as one sentence from the tenure facts, not a list of 'Has' lines", () => {
    const evidence: ManualEvidence[] = [
      ...PROFILE,
      { id: "f-years-arch", evidence_type: "FACT", label: "f-years-arch", fact_type: "TECHNOLOGY",
        statement: "Has 15 years of professional software-industry experience across enterprise architecture and data platforms." },
      { id: "f-years-code", evidence_type: "FACT", label: "f-years-code", fact_type: "TECHNOLOGY",
        statement: "Has 2 years of direct AI and software coding experience, including Python and TypeScript." },
    ];
    const docs = buildControlledDocuments(comparison([requirement("R-1", "Master data and data governance")], [pair("R-1", "f-golden", 0.9)], evidence),
      { full_name: "Candidate Example", phone: "+65 6000 0000" }, { asOf: new Date("2026-11-02T00:00:00Z") });
    const summary = docs.cv.split("## Summary\n")[1].split("\n")[0];
    expect(summary).toBe("Brings 15 years of professional software-industry experience across enterprise architecture and data platforms; "
      + "and 2 years of direct AI and software coding experience, including Python and TypeScript.");
    expect(docs.claims.filter((claim) => claim.section === "Summary")).toEqual([
      expect.objectContaining({ evidenceIds: ["f-years-arch", "f-years-code"] }),
    ]);
  });

  it("prints apostrophes, dashes, bullets and accents in the PDF instead of hyphens", () => {
    expect(winAnsiPdfText("Moody’s – café (Mondelēz) 叶")).toBe("Moody\x92s \x96 caf\xe9 \\(Mondelez\\) ?");
    const pdf = renderControlledPdf("# Candidate\nline\n\n- Rated by Moody’s and S&P").toString("latin1");
    expect(pdf).toContain("Moody\x92s");
    expect(pdf).not.toContain("Moody-s");
    expect(pdf).toContain("/Encoding /WinAnsiEncoding");
  });
});
