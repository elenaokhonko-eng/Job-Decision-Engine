import { describe, expect, it } from "vitest";

import {
  documentRequirements,
  isWorkabilityRequirement,
  postingRequirementLines,
  type StoredRequirementRow,
} from "../../documents/manualDocumentPolicy.js";
import {
  MANUAL_COVER_LETTER_SCHEMA_VERSION,
  MANUAL_SUMMARY_SCHEMA_VERSION,
  validateCoverLetterPayload,
  validateSummaryPayload,
  type CoverLetterPair,
} from "../../documents/manualCoverLetter.js";
import {
  buildControlledDocuments,
  buildManualComparison,
  cvStatement,
  matchableEvidence,
  MAX_CV_STATEMENT_WORDS,
  pdfPageCount,
  renderControlledPdf,
  rowAttention,
  tenureStatements,
  type ManualEvidence,
} from "../../documents/manualPreparation.js";
import {
  INVESTMENT_DATA_SCIENTIST_DESCRIPTION,
  INVESTMENT_DATA_SCIENTIST_NARRATIVE,
  INVESTMENT_DATA_SCIENTIST_QUALIFICATIONS,
} from "../fixtures/investmentDataScientist.js";

const quotedRow = (key: string, text: string, importance = "MUST"): StoredRequirementRow => ({
  requirement_key: key, requirement_type: "SKILL", importance, requirement_text: text, extractor_type: "LLM_QUOTED", quote_text: text,
});

describe("posting parser on a question-headed posting", () => {
  it("turns every qualification bullet into a row and none of the narrative or office logistics", () => {
    const lines = postingRequirementLines(INVESTMENT_DATA_SCIENTIST_DESCRIPTION);
    const requirementTexts = lines.filter((line) => line.requirement_type === "POSTING_REQUIREMENT").map((line) => line.requirement_text);
    expect(requirementTexts).toEqual(INVESTMENT_DATA_SCIENTIST_QUALIFICATIONS);
    expect(lines.filter((line) => line.requirement_type === "POSTING_RESPONSIBILITY").map((line) => line.requirement_text)).toEqual([
      "Build and deploy machine learning models that support investment decisions",
      "Turn alternative and market data into features that portfolio teams can use",
      "Work with data engineers to put models into production and monitor them",
    ]);

    // The model's quotes included the team description and the office line; neither survives.
    const rows = documentRequirements([
      quotedRow("Q-1", INVESTMENT_DATA_SCIENTIST_NARRATIVE[0]),
      quotedRow("Q-2", INVESTMENT_DATA_SCIENTIST_NARRATIVE[1]),
      quotedRow("Q-3", "Come into the office four days per week"),
      quotedRow("Q-4", INVESTMENT_DATA_SCIENTIST_QUALIFICATIONS[1]),
    ], INVESTMENT_DATA_SCIENTIST_DESCRIPTION);
    const texts = rows.map((row) => row.requirement_text);
    for (const qualification of INVESTMENT_DATA_SCIENTIST_QUALIFICATIONS) expect(texts).toContain(qualification);
    for (const narrative of INVESTMENT_DATA_SCIENTIST_NARRATIVE) expect(texts).not.toContain(narrative);
    expect(texts.some((text) => /office/i.test(text))).toBe(false);
  });

  it("treats office attendance, hybrid and on-site rules as workability, but not hybrid cloud", () => {
    for (const line of [
      "Come into the office four days per week",
      "This is a hybrid role with 3 days a week in the office",
      "On-site presence at our Singapore campus is expected",
      "Days in office: Monday to Thursday",
    ]) expect(isWorkabilityRequirement(line), line).toBe(true);
    expect(isWorkabilityRequirement("Experience designing hybrid cloud data platforms")).toBe(false);
  });
});

const fact = (id: string, statement: string, engagementId?: string): ManualEvidence => ({
  id, evidence_type: "FACT", label: id, statement, fact_type: "PROJECT", ...(engagementId ? { engagement_id: engagementId } : {}),
});
const tenureAi = fact("fact-tenure-ai", "Has 2 years of direct AI and software coding experience, including Python and data science.");
const tenureAll = fact("fact-tenure-all", "Has 20 years of overall professional production experience across institutional technology.");
const calypso = fact("fact-calypso", "Took a derivatives and collateral programme to group sign-off, moving it onto BNPP Calypso.", "eng-aim");
const api = fact("fact-api", "Built cloud-native API orchestrations handling ~1,000 transactions daily.", "eng-venture");
const mlFoundation = fact("fact-ml", "Designed the data foundation that future machine-learning models will train on.", "eng-venture");
const tenure = tenureStatements([tenureAi, tenureAll]);

describe("row attention and suggested status", () => {
  it("flags a market the evidence does not name and suggests partly met (commodity against rates derivatives)", () => {
    const check = rowAttention("Commodity derivatives, futures curves and roll mechanics", [calypso], tenure);
    expect(check.suggestedStatus).toBe("PARTIAL");
    expect(check.attention[0]).toMatchObject({ code: "DOMAIN_QUALIFIER" });
    expect(check.attention[0].detail).toContain("commodities");
  });

  it("compares a years threshold with the profile's own tenure for that field", () => {
    const short = rowAttention("At least 3 years of hands-on experience building machine learning models in production", [mlFoundation], tenure);
    expect(short.suggestedStatus).toBe("PARTIAL");
    expect(short.attention.find((item) => item.code === "YEARS_THRESHOLD")?.detail).toContain("your profile states 2");
    // Enough years for the field: flagged for a look, not marked partial.
    const enough = rowAttention("At least 10 years in institutional technology", [api], tenure);
    expect(enough.suggestedStatus).toBeNull();
    expect(enough.attention.map((item) => item.code)).toEqual(["YEARS_THRESHOLD"]);
  });

  it("flags a named certification that no credential backs", () => {
    expect(rowAttention("CFA charterholder preferred", [api], []).attention.map((item) => item.code)).toEqual(["NAMED_CERTIFICATION"]);
  });

  it("puts the flags and the suggestion on the comparison rows", () => {
    const comparison = buildManualComparison({
      canonical_job_id: "job", job_version_id: "version", source_observation_id: "observation", source_evidence_fingerprint: "a".repeat(64),
      job_content_hash: "hash", title: "Product Leader", company: "Example Trading", canonical_url: null, profile_version_id: "profile",
      candidate_profile_id: "candidate", requirement_set_id: "set", profile_contact_fact_ids: [], profile_contact_fingerprint: "b".repeat(64),
      preference_context_fingerprint: "c".repeat(64), context_fingerprint: "d".repeat(64), suitability_warnings: [],
      requirements: [{ requirement_key: "R-1", requirement_type: "SKILL", importance: "MUST", requirement_text: "Commodity derivatives and futures curves" }],
      evidence: [calypso, tenureAi],
      pairing: { pairs: [{ requirement_key: "R-1", evidence_id: "fact-calypso", confidence: 0.9, justification: "derivatives programme" }] },
    }) as { rows: Array<Record<string, unknown>> };
    expect(comparison.rows[0]).toMatchObject({ suggested_status: "PARTIAL", attention: [expect.objectContaining({ code: "DOMAIN_QUALIFIER" })] });
  });

  it("never offers facts from a role the profile hides", () => {
    const hiddenRole: ManualEvidence = { id: "eng-lab", evidence_type: "ENGAGEMENT", label: "Founder at Research Lab", statement: "Founder at Research Lab.", document_layout: "HIDDEN" };
    const labFact = fact("fact-lab", "Built multi-agent research tools for literature synthesis.", "eng-lab");
    expect(matchableEvidence([hiddenRole, labFact, api]).map((item) => item.id)).toEqual(["fact-api"]);
  });
});

describe("summary and letter grounding", () => {
  const pairs: CoverLetterPair[] = [
    { requirement_key: "R-1", importance: "MUST", requirement: "API and integration architecture", evidence: [api], status: "ACCEPTED" },
    { requirement_key: "R-2", importance: "MUST", requirement: "3 years hands-on machine learning", evidence: [mlFoundation], status: "PARTIAL" },
    { requirement_key: "R-3", importance: "MUST", requirement: "Commodity derivatives", evidence: [calypso], status: "ACCEPTED" },
  ];
  const allowed = [api, mlFoundation, calypso, tenureAll];
  const summary = (second: { text: string; evidence_ids: string[]; requirement_keys: string[] }) => validateSummaryPayload({
    schema_version: MANUAL_SUMMARY_SCHEMA_VERSION,
    sentences: [
      { text: "Technology architect with 20 years across institutional technology.", evidence_ids: ["fact-tenure-all"], requirement_keys: [] },
      second,
      { text: "This record fits the role's integration architecture needs.", evidence_ids: ["fact-api"], requirement_keys: ["R-1"] },
    ],
  }, pairs, allowed, { jobTitle: "AVP/VP, Data Scientist, Investment Insights Group" });
  const issuesOf = (result: ReturnType<typeof validateSummaryPayload>) => (result.valid ? [] : result.issues).join(" ");

  it("accepts a grounded summary", () => {
    expect(summary({ text: "Built cloud-native API orchestrations handling about 1,000 transactions a day.", evidence_ids: ["fact-api"], requirement_keys: ["R-1"] }))
      .toMatchObject({ valid: true });
  });

  it("rejects quantity words the evidence does not state", () => {
    expect(issuesOf(summary({ text: "Built API orchestrations processing thousands of daily transactions.", evidence_ids: ["fact-api"], requirement_keys: ["R-1"] })))
      .toContain("thousands");
  });

  it("rejects praise, unbacked markets and claims on partly met rows", () => {
    const commodity = issuesOf(summary({ text: "Possesses deep knowledge of commodity derivatives and collateral programmes.", evidence_ids: ["fact-calypso"], requirement_keys: ["R-3"] }));
    expect(commodity).toContain("\"deep\"");
    expect(commodity).toContain("commodities");
    expect(issuesOf(summary({ text: "Designed the data foundation for future machine-learning models.", evidence_ids: ["fact-ml"], requirement_keys: ["R-2"] })))
      .toContain("only partly met");
    expect(issuesOf(summary({ text: "Took a derivatives programme to sign-off, which aligns perfectly with this role.", evidence_ids: ["fact-calypso"], requirement_keys: ["R-3"] })))
      .toContain("perfectly");
  });

  it("rejects the posting's title used as the candidate's own", () => {
    expect(issuesOf(summary({ text: "Data scientist who built API orchestrations for about 1,000 transactions a day.", evidence_ids: ["fact-api"], requirement_keys: ["R-1"] })))
      .toContain("data scientist");
  });

  it("rejects passive voice in the letter", () => {
    const letter = validateCoverLetterPayload({
      schema_version: MANUAL_COVER_LETTER_SCHEMA_VERSION,
      opening: { text: "The role's focus on integration architecture matches the work I want to do next.", requirement_keys: ["R-1"] },
      paragraphs: [
        { sentences: [{ text: "The API orchestration layer was designed and built to handle about 1,000 transactions a day.", evidence_ids: ["fact-api"], requirement_keys: ["R-1"] }] },
        { sentences: [{ text: "I designed the data foundation that future machine-learning models will train on.", evidence_ids: ["fact-ml"], requirement_keys: ["R-2"] }] },
      ],
      gap_note: null,
    }, pairs, allowed);
    expect(letter.valid ? "" : letter.issues.join(" ")).toContain("passive voice");
  });
});

describe("CV shape", () => {
  const longFact = fact("fact-rag", "Designed and built the LLM and retrieval-augmented generation layer that turns a user's uploaded evidence (bank statements, chat logs, contracts, employment records) into structured, evidence-linked claim packs for dispute forums. PostgreSQL is the system of record, with row-level security enforced and tested in CI.", "eng-venture");

  it("prints a short form of long facts: the candidate's own, else the first sentence without asides", () => {
    const short = cvStatement(longFact);
    expect(short.split(/\s+/).length).toBeLessThanOrEqual(MAX_CV_STATEMENT_WORDS);
    expect(short).toBe("Designed and built the LLM and retrieval-augmented generation layer that turns a user's uploaded evidence into structured, evidence-linked claim packs for dispute forums.");
    expect(cvStatement({ ...longFact, cv_statement: "Built the LLM and RAG layer that turns uploaded evidence into dispute claim packs." }))
      .toBe("Built the LLM and RAG layer that turns uploaded evidence into dispute claim packs.");
    expect(cvStatement(api)).toBe(api.statement);
    // Cut at a colon, never at a comma that would leave "moving a highly manual."
    expect(cvStatement(fact("f-eval", "Built the evaluation and safety controls for AI-generated guidance: contract tests against each forum's procedural requirements, readiness checks before release, data-quality gates on ingestion, and CI release gates covering type checks and migrations.")))
      .toBe("Built the evaluation and safety controls for AI-generated guidance.");
    const noSafeCut = fact("f-pine", "Took a derivatives and collateral programme that had been failing for 2 to 3 years to group sign-off in under 6 months, moving a highly manual, Excel-based process onto a vendor platform with requirements and design confirmed with the vendor team.");
    expect(cvStatement(noSafeCut)).toBe(noSafeCut.statement);
  });

  const comparisonWith = (evidence: ManualEvidence[], rows: Array<Record<string, unknown>> = []) => ({
    title: "Data Scientist", company: "Example Fund", evidence, rows, requirements: [],
  });
  const venture: ManualEvidence = {
    id: "eng-venture", evidence_type: "ENGAGEMENT", label: "Founder and Principal AI Architect at Example AI SG Pte Ltd",
    statement: "Founder and Principal AI Architect at Example AI SG Pte Ltd (2025-08-01–present). Dispute AI.", engagement_id: "eng-venture",
    engagement_type: "FOUNDER_OPERATOR", experience_class: "PROFESSIONAL_PRODUCTION", start_date: "2025-08-01", document_layout: "FULL",
  };
  const lab: ManualEvidence = {
    id: "eng-lab2", evidence_type: "ENGAGEMENT", label: "Founder in Residence at Venture Lab", statement: "Founder in Residence at Venture Lab (2025-08-01–2025-12-31).",
    engagement_id: "eng-lab2", engagement_type: "FOUNDER_OPERATOR", experience_class: "APPLIED_PROJECT", start_date: "2025-08-01", end_date: "2025-12-31",
  };
  const aim: ManualEvidence = {
    id: "eng-aim", evidence_type: "ENGAGEMENT", label: "Program Lead at Insurer Investment Management", statement: "Program Lead at Insurer Investment Management (2023-04-01–2025-04-30).",
    engagement_id: "eng-aim", engagement_type: "EMPLOYEE", experience_class: "PROFESSIONAL_PRODUCTION", start_date: "2023-04-01", end_date: "2025-04-30",
  };
  const degree: ManualEvidence = {
    id: "cred-msc", evidence_type: "CREDENTIAL", label: "Master of Science in Wealth Management", credential_type: "DEGREE",
    statement: "Master of Science in Wealth Management, degree issued by Example University; status ACTIVE.", issuer: "Example University", issued_on: "2015-06-30",
  };
  const contact = { full_name: "Candidate Example", phone: "+65 6000 0000" };

  it("lists a founder role at a registered company under Experience, in date order, and a venture lab apart", () => {
    const docs = buildControlledDocuments(comparisonWith([venture, lab, aim, longFact, calypso, degree]), contact, { asOf: new Date("2026-11-05T00:00:00Z") });
    const experience = docs.cv.split("## Experience\n")[1]?.split("\n## ")[0] ?? "";
    expect(experience.indexOf("Example AI SG Pte Ltd")).toBeGreaterThan(-1);
    expect(experience.indexOf("Example AI SG Pte Ltd")).toBeLessThan(experience.indexOf("Insurer Investment Management"));
    expect(experience).not.toContain("Venture Lab");
    // The long fact is printed in its short form, once.
    expect(docs.cv.split(cvStatement(longFact)).length - 1).toBe(1);
    expect(docs.cv).not.toContain("row-level security");
    expect(docs.cv).toContain("## Education\n- Master of Science in Wealth Management, Example University, 2015");
  });

  it("leaves out the requirement-matching section unless asked, and counts PDF pages", () => {
    const rows = [{ requirement_key: "R-1", importance: "MUST", requirement: "Integration architecture", evidence: [{ id: "fact-calypso" }] }];
    const plain = buildControlledDocuments(comparisonWith([aim, calypso], rows), contact, { asOf: new Date("2026-11-05T00:00:00Z") });
    expect(plain.cv).not.toContain("How my experience matches this role");
    const withSection = buildControlledDocuments(comparisonWith([aim, calypso], rows), contact, { asOf: new Date("2026-11-05T00:00:00Z"), includeMatchSection: true });
    expect(withSection.cv).toContain("## How my experience matches this role\n- Integration architecture: ");
    expect(pdfPageCount(renderControlledPdf(plain.cv))).toBe(1);
    expect(pdfPageCount(renderControlledPdf(Array.from({ length: 200 }, (_, index) => `- Line ${index}`).join("\n")))).toBeGreaterThan(1);
  });
});
