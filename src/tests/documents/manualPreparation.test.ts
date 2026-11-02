import { describe, expect, it } from "vitest";
import { PDFParse } from "pdf-parse";
import JSZip from "jszip";
import {
  buildControlledDocuments,
  buildManualComparison,
  fingerprintManualComparison,
  renderControlledDocx,
  renderControlledPdf,
  sha256Buffer,
  validateManualApprovalCurrentness,
  validateManualArtifactPair,
  type ManualComparisonInput,
} from "../../documents/manualPreparation.js";

function input(): ManualComparisonInput {
  return {
    canonical_job_id: "11111111-1111-4111-8111-111111111111",
    job_version_id: "22222222-2222-4222-8222-222222222222",
    source_observation_id: "33333333-3333-4333-8333-333333333333",
    source_evidence_fingerprint: "f".repeat(64),
    job_content_hash: "a".repeat(64),
    title: "Data Architect",
    company: "Example",
    canonical_url: "https://example.test/role",
    profile_version_id: "44444444-4444-4444-8444-444444444444",
    candidate_profile_id: "55555555-5555-4555-8555-555555555555",
    requirement_set_id: "66666666-6666-4666-8666-666666666666",
    profile_contact_fact_ids: ["77777777-7777-4777-8777-777777777777"],
    profile_contact_fingerprint: "b".repeat(64),
    preference_context_fingerprint: "c".repeat(64),
    context_fingerprint: "d".repeat(64),
    requirements: [{ requirement_key: "R-001", requirement_type: "FUNCTION", importance: "MUST", requirement_text: "Build data architecture" }],
    evidence: [
      { id: "fact-coding", evidence_type: "FACT", label: "coding", statement: "Approximately two years of hands-on coding experience." },
      { id: "fact-architecture", evidence_type: "FACT", label: "architecture", statement: "Twelve years of technical-functional architecture experience." },
      { id: "fact-data", evidence_type: "FACT", label: "data architecture", statement: "Designed data architecture for regulated systems." },
    ],
    suitability_warnings: ["Automatic suitability gate: NEEDS_VERIFICATION."],
  };
}

describe("manual application preparation", () => {
  it("rejects approval use after any version, contact, requirement, or comparison input changes", () => {
    const pinned = {
      canonicalJobId: "11111111-1111-4111-8111-111111111111",
      jobVersionId: "22222222-2222-4222-8222-222222222222",
      sourceObservationId: "33333333-3333-4333-8333-333333333333",
      jobContentHash: "a".repeat(64),
      profileVersionId: "44444444-4444-4444-8444-444444444444",
      candidateProfileId: "55555555-5555-4555-8555-555555555555",
      profileContactFactIdsFingerprint: "e".repeat(64),
      profileContactFingerprint: "b".repeat(64),
      preferenceContextFingerprint: "c".repeat(64),
      requirementSetId: "66666666-6666-4666-8666-666666666666",
      comparatorVersion: "literal-overlap-v1",
      comparisonFingerprint: "f".repeat(64),
    };
    expect(validateManualApprovalCurrentness(pinned, pinned)).toEqual({ ok: true });
    for (const [key, value] of Object.entries(pinned)) {
      expect(validateManualApprovalCurrentness(pinned, { ...pinned, [key]: `${value}-changed` })).toEqual({ ok: false, reason: key });
    }
  });

  it("requires one private artifact per format and a distinct run for each document", () => {
    const pair = [
      { document_type: "CV" as const, format: "DOCX" as const, document_run_id: "cv-run" },
      { document_type: "CV" as const, format: "PDF" as const, document_run_id: "cv-run" },
      { document_type: "COVER_LETTER" as const, format: "DOCX" as const, document_run_id: "letter-run" },
      { document_type: "COVER_LETTER" as const, format: "PDF" as const, document_run_id: "letter-run" },
    ];
    expect(() => validateManualArtifactPair(pair)).not.toThrow();
    expect(() => validateManualArtifactPair(pair.slice(0, 3))).toThrow(/pair validation/);
    expect(() => validateManualArtifactPair(pair.map((item) => ({ ...item, document_run_id: "same-run" })))).toThrow(/pair validation/);
  });

  it("pins comparison identity and changes fingerprint when any compared input changes", () => {
    const first = buildManualComparison(input());
    const second = buildManualComparison({ ...input(), profile_version_id: "88888888-8888-4888-8888-888888888888" });
    const third = buildManualComparison({ ...input(), requirements: [{ ...input().requirements[0], requirement_text: "Build cloud data architecture" }] });
    const fourth = buildManualComparison({ ...input(), source_evidence_fingerprint: "9".repeat(64) });
    expect(first).toMatchObject({ job_version_id: input().job_version_id, profile_version_id: input().profile_version_id, requirement_set_id: input().requirement_set_id });
    expect(fingerprintManualComparison(first)).not.toBe(fingerprintManualComparison(second));
    expect(fingerprintManualComparison(first)).not.toBe(fingerprintManualComparison(third));
    expect(fingerprintManualComparison(first)).not.toBe(fingerprintManualComparison(fourth));
    expect((first.rows as Array<any>)[0].evidence[0].statement).toBe("Designed data architecture for regulated systems.");
  });

  it("uses exact profile statements and keeps coding and architecture tenure distinct", () => {
    const docs = buildControlledDocuments(buildManualComparison(input()), {
      full_name: "Candidate Example", location: "Singapore", email: "candidate@example.test", phone: "+65 6000 0000",
    });
    expect(docs.cv).toContain("Approximately two years of hands-on coding experience.");
    expect(docs.cv).toContain("Twelve years of technical-functional architecture experience.");
    expect(docs.cv).not.toContain("Fourteen years");
    expect(docs.cv).toContain("+65 6000 0000");
    expect(docs.coverLetter).toContain("Designed data architecture for regulated systems.");
    expect(docs.claims.some((claim) => claim.text === "Approximately two years of hands-on coding experience.")).toBe(true);
    expect(() => buildControlledDocuments(buildManualComparison(input()), { full_name: "Candidate Example" })).toThrow(/phone/);
  });

  it("renders a valid private DOCX and parseable PDF payload", async () => {
    const docs = buildControlledDocuments(buildManualComparison(input()), { full_name: "Candidate Example", phone: "+65 6000 0000" });
    const docx = await renderControlledDocx(docs.cv);
    const pdf = renderControlledPdf(docs.cv);
    expect(docx.subarray(0, 2).toString("ascii")).toBe("PK");
    const wordPackage = await JSZip.loadAsync(docx);
    const documentXml = await wordPackage.file("word/document.xml")?.async("string");
    expect(documentXml).toContain("Twelve years of technical-functional architecture experience.");
    expect(pdf.subarray(0, 8).toString("ascii")).toBe("%PDF-1.4");
    expect(pdf.toString("ascii")).toContain("%%EOF");
    expect(sha256Buffer(docx)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Buffer(pdf)).toMatch(/^[0-9a-f]{64}$/);
    const parser = new PDFParse({ data: pdf });
    try {
      const parsed = await parser.getText();
      expect(parsed.text).toContain("Candidate Example");
      expect(parsed.text).toContain("Twelve years of technical-functional architecture experience.");
    } finally {
      await parser.destroy();
    }
  });

  it("tailors the CV to the job's own requirement wording and ranks each role's facts by relevance", async () => {
    const tailored: ManualComparisonInput = {
      ...input(),
      requirements: [
        { requirement_key: "R-001", requirement_type: "FUNCTION", importance: "PREFERRED", requirement_text: "Experience with Salesforce CRM rollouts." },
        { requirement_key: "R-002", requirement_type: "FUNCTION", importance: "MUST", requirement_text: "Lead derivatives operating model design." },
      ],
      evidence: [
        { id: "eng-aia", evidence_type: "ENGAGEMENT", label: "Program Lead at AIA", statement: "Program Lead at AIA (2023-04-01–2025-04-30). Front office transformation.", engagement_id: "eng-aia" },
        { id: "eng-mdlz", evidence_type: "ENGAGEMENT", label: "CRM Architect at Mondelez", statement: "CRM Architect at Mondelez (2012-02-01–2017-09-30). Regional CRM.", engagement_id: "eng-mdlz" },
        { id: "eng-tour", evidence_type: "ENGAGEMENT", label: "Intern at Tourism Agency", statement: "Intern at Tourism Agency (1999-01-01–2000-12-31). Tour logistics.", engagement_id: "eng-tour" },
        { id: "fact-aia-ifrs", evidence_type: "FACT", label: "aia.ifrs", statement: "Aligned investment operations with IFRS 17 accounting standards.", engagement_id: "eng-aia" },
        { id: "fact-aia-tom", evidence_type: "FACT", label: "aia.tom", statement: "Designed the derivatives operating model for a $25B portfolio.", engagement_id: "eng-aia" },
        { id: "fact-mdlz-sfa", evidence_type: "FACT", label: "mdlz.sfa", statement: "Led Salesforce CRM rollouts for 1,300 users across 16 markets.", engagement_id: "eng-mdlz" },
        { id: "cred-cfa", evidence_type: "CREDENTIAL", label: "Passed Level I of the CFA Program", statement: "Passed Level I of the CFA Program, course issued by CFA Institute; status ACTIVE." },
      ],
    };
    const comparison = buildManualComparison(tailored);
    const docs = buildControlledDocuments(comparison, { full_name: "Candidate Example", phone: "+65 6000 0000" }, { asOf: new Date("2026-11-02T00:00:00Z") });

    // The MUST requirement leads, in the job's own words, paired with its evidence.
    const mustLine = docs.cv.indexOf("- Lead derivatives operating model design: Designed the derivatives operating model");
    const preferredLine = docs.cv.indexOf("- Experience with Salesforce CRM rollouts: Led Salesforce CRM rollouts");
    expect(mustLine).toBeGreaterThan(-1);
    expect(preferredLine).toBeGreaterThan(mustLine);
    // Past-role facts appear under their role, with the relevant fact ranked first.
    const aia = docs.cv.indexOf("### Program Lead at AIA | Apr 2023 – Apr 2025");
    expect(aia).toBeGreaterThan(-1);
    expect(docs.cv.indexOf("Designed the derivatives operating model", aia)).toBeLessThan(docs.cv.indexOf("Aligned investment operations with IFRS 17", aia));
    expect(docs.cv).toContain("### CRM Architect at Mondelez | Feb 2012 – Sep 2017");
    // A role over 20 years old is summarised in one earlier-career line, not dropped.
    expect(docs.cv).toContain("## Earlier career\n- Earlier roles (1999–2000): Tourism Agency");
    expect(docs.cv).toContain("- Passed Level I of the CFA Program");
    expect(docs.coverLetter).toContain('On "Lead derivatives operating model design": Designed the derivatives operating model');
    // Every claim resolves to approved evidence.
    const evidenceIds = new Set(tailored.evidence.map((item) => item.id));
    expect(docs.claims.every((item) => item.evidenceIds.length > 0 && item.evidenceIds.every((id) => evidenceIds.has(id)))).toBe(true);

    const documentXml = await (await JSZip.loadAsync(await renderControlledDocx(docs.cv))).file("word/document.xml")?.async("string");
    expect(documentXml).toContain("Lead derivatives operating model design: Designed the derivatives operating model");
    expect(documentXml).toContain("Program Lead at AIA | Apr 2023 – Apr 2025");
  });
});
