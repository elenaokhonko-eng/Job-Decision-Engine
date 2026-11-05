import { describe, expect, it } from "vitest";

import {
  assertNoInternalAssessmentText,
  documentRequirements,
  isInternalAssessmentStatement,
  MAX_OPTIONAL_THEMES,
  postingRequirementLines,
  type StoredRequirementRow,
} from "../../documents/manualDocumentPolicy.js";
import { buildControlledDocuments, buildManualComparison, planRoles, type ManualEvidence } from "../../documents/manualPreparation.js";
import { SYSTEMATIC_TRADING_PRODUCT_LEAD_DESCRIPTION as JOB_DESCRIPTION } from "../fixtures/systematicTradingProductLead.js";
import {
  EXCHANGE_DERIVATIVES_PRODUCT_OWNER_DESCRIPTION as EXCHANGE_DESCRIPTION,
  EXCHANGE_DERIVATIVES_PRODUCT_OWNER_REQUIREMENTS as EXCHANGE_REQUIREMENTS,
  EXCHANGE_DERIVATIVES_PRODUCT_OWNER_RESPONSIBILITIES as EXCHANGE_RESPONSIBILITIES,
} from "../fixtures/exchangeDerivativesProductOwnerLead.js";

// The deterministic extractor's rows when AI extraction fails: fixed labels, not the employer's words.
const PLACEHOLDER_ROWS: StoredRequirementRow[] = [
  { requirement_key: "R-001", requirement_type: "EMPLOYMENT_TYPE", importance: "MUST", requirement_text: "Role specifies an employment type.", extractor_type: "DETERMINISTIC", quote_text: "Full-time" },
  { requirement_key: "R-002", requirement_type: "DOMAIN", importance: "MUST", requirement_text: "Role includes a target technical domain requirement.", extractor_type: "DETERMINISTIC", quote_text: "data platforms" },
];

const engagement = (id: string, label: string, start: string, end: string | null, type: ManualEvidence["engagement_type"], experienceClass: string): ManualEvidence => ({
  id, evidence_type: "ENGAGEMENT", label, engagement_id: id, engagement_type: type, experience_class: experienceClass, start_date: start,
  ...(end ? { end_date: end } : {}), statement: `${label} (${start}–${end ?? "present"}). Role summary.`,
});
const fact = (id: string, statement: string, engagementId?: string, factType = "ACHIEVEMENT"): ManualEvidence => ({
  id, evidence_type: "FACT", label: id, statement, fact_type: factType, ...(engagementId ? { engagement_id: engagementId } : {}),
});
const credential = (id: string, name: string, type: NonNullable<ManualEvidence["credential_type"]>): ManualEvidence => ({
  id, evidence_type: "CREDENTIAL", label: name, credential_type: type, statement: `${name}, ${type.toLowerCase()} issued by Issuer; status ACTIVE.`,
});

// Shaped like the real profile: four concurrent recent ventures, a certification sprint, one major and
// relevant past employment role, and older roles back to 1999.
const PROFILE: ManualEvidence[] = [
  engagement("eng-lab", "Founder at Neurodiversity Research Lab", "2026-05-01", null, "RESEARCHER", "APPLIED_PROJECT"),
  engagement("eng-campus", "Founder in Residence at City University", "2026-01-01", null, "FOUNDER_OPERATOR", "PROFESSIONAL_PRODUCTION"),
  engagement("eng-venture", "Founder and AI Architect at Venture AI", "2025-08-01", null, "FOUNDER_OPERATOR", "PROFESSIONAL_PRODUCTION"),
  engagement("eng-accelerator", "Founder in Residence at Business School Lab", "2025-08-01", "2025-12-31", "FOUNDER_OPERATOR", "APPLIED_PROJECT"),
  engagement("eng-sprint", "Certification Sprint at Strategy Consultancy", "2025-07-01", "2025-08-31", "RESEARCHER", "COURSE_PROJECT"),
  engagement("eng-aim", "Enterprise Solution Architect and Program Lead at Insurer Investment Management", "2023-04-01", "2025-04-30", "EMPLOYEE", "PROFESSIONAL_PRODUCTION"),
  engagement("eng-boutique", "Associate Director at Boutique Asset Manager", "2019-07-01", "2022-12-31", "EMPLOYEE", "PROFESSIONAL_PRODUCTION"),
  engagement("eng-crm", "Regional CRM Architect at Consumer Goods Company", "2012-02-01", "2017-09-30", "EMPLOYEE", "PROFESSIONAL_PRODUCTION"),
  engagement("eng-import", "Import-Export Coordinator at Trading House", "2000-01-01", "2002-12-31", "EMPLOYEE", "PROFESSIONAL_PRODUCTION"),
  engagement("eng-tourism", "Tourism Management Intern at Tourism Agency", "1999-01-01", "2000-12-31", "CONTRACTOR", "PROFESSIONAL_PRODUCTION"),
  fact("f-aim-front-office", "Led front office transformation of order management and trade lifecycle workflows for a multi-asset investment management platform.", "eng-aim"),
  fact("f-aim-derivatives", "Designed the derivatives operating model and portfolio management data flows for a $25B investment portfolio.", "eng-aim"),
  fact("f-aim-governance", "Defined data governance for market data and reference data used by investment and risk teams.", "eng-aim"),
  fact("f-venture-agentic", "Architects agentic AI and machine learning tooling on a governed data platform for financial advisers.", "eng-venture"),
  fact("f-lab-research", "Runs participatory research studies on neurodivergent learning.", "eng-lab"),
  fact("f-campus-mentoring", "Mentors student founders on venture building.", "eng-campus"),
  fact("f-accelerator-pitch", "Prepared an AI governance venture pitch for an accelerator cohort.", "eng-accelerator"),
  fact("f-sprint-change", "Completed a digital transformation and change management certification sprint.", "eng-sprint"),
  fact("f-boutique-portfolios", "Managed discretionary portfolio management workflows and order management for private clients.", "eng-boutique"),
  fact("f-crm-rollout", "Led regional CRM and sales force automation rollouts across 16 markets.", "eng-crm"),
  fact("f-tenure-architecture", "Has 12 years of technical-functional architecture experience.", undefined, "SKILL"),
  fact("f-tenure-coding", "Has approximately two years of hands-on coding experience.", undefined, "SKILL"),
  fact("f-python-sql", "Uses Python and SQL for data analysis and pipeline prototypes.", undefined, "TECHNOLOGY"),
  fact("f-rating-markets", "Capital Markets domain expertise (Self-rating: 5/5): institutional trading, derivatives and market data.", undefined, "DOMAIN"),
  fact("f-rating-sustainability", "Sustainability domain expertise (Self-rating: 1/5): emerging interest in climate data.", undefined, "DOMAIN"),
  fact("f-not-target", "Pure public policy research: foundational knowledge; not a target work activity.", undefined, "SKILL"),
  credential("c-msc", "Master of Science in Wealth Management", "DEGREE"),
  credential("c-mba", "Master of Business Administration", "DEGREE"),
  credential("c-aws", "AWS Certified AI Practitioner", "CERTIFICATION"),
  { ...credential("c-cfa", "Passed Level I of the CFA Program", "COURSE"), always_include: true },
  credential("c-data-ai", "Advanced Professional Certificate in Data Science and AI", "COURSE"),
  credential("c-prince2", "PRINCE2 Practitioner", "CERTIFICATION"),
  credential("c-fund-rules", "Rules and Regulations for Fund Management", "LICENSE"),
  credential("c-advisory", "Client Advisory Competency Standards", "LICENSE"),
  credential("c-advisory-rules", "Rules and Regulations for Financial Advisory Services", "LICENSE"),
  credential("c-health", "Health Insurance Certification", "CERTIFICATION"),
];

function comparisonFor(requirements: ReturnType<typeof documentRequirements>, evidence = PROFILE) {
  return buildManualComparison({
    canonical_job_id: "11111111-1111-4111-8111-111111111111",
    job_version_id: "22222222-2222-4222-8222-222222222222",
    source_observation_id: "33333333-3333-4333-8333-333333333333",
    source_evidence_fingerprint: "f".repeat(64),
    job_content_hash: "a".repeat(64),
    title: "Product Lead - Systematic Commodity Trading",
    company: "Example Commodities",
    canonical_url: "https://example.test/role",
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
  });
}

const CONTACT = { full_name: "Candidate Example", phone: "+65 6000 0000" };
const AS_OF = new Date("2026-11-02T00:00:00Z");

function section(cv: string, heading: string): string {
  const start = cv.indexOf(`## ${heading}\n`);
  if (start < 0) return "";
  const body = cv.slice(start + heading.length + 4);
  const next = body.indexOf("\n## ");
  return (next < 0 ? body : body.slice(0, next)).trim();
}

describe("manual document quality (baseline regression)", () => {
  // The loader drops internal assessment facts before comparison; the builder filters them again.
  const evidence = PROFILE.filter((item) => !isInternalAssessmentStatement(item.statement));
  const requirements = documentRequirements(PLACEHOLDER_ROWS, JOB_DESCRIPTION);
  const docs = buildControlledDocuments(comparisonFor(requirements, evidence), CONTACT, { asOf: AS_OF, includeMatchSection: true });

  it("uses the posting's own lines instead of placeholder requirements when AI extraction failed", () => {
    expect(requirements.map((row) => row.requirement_text)).toEqual([
      "Product or program leadership for front office trading or investment management platforms.",
      "Working knowledge of derivatives, portfolio management and trade lifecycle operations.",
      "Experience delivering data platforms and agentic AI or machine learning tooling for investment teams.",
      "Familiarity with Python and SQL is a plus.",
      "Own the product roadmap for the systematic trading platform, from research tooling to execution.",
      "Translate requirements from traders, quants and risk managers into delivery plans for engineering teams.",
      "Lead front office transformation of order management, market data and position keeping workflows.",
      "Define data governance for market data, reference data and trade data across the platform.",
    ]);
    expect(requirements.find((row) => row.requirement_text.startsWith("Familiarity with Python"))?.importance).toBe("PREFERRED");
    for (const text of [docs.cv, docs.coverLetter]) {
      expect(text).not.toMatch(/Role specifies|Role includes a target|Role requires/);
      expect(text).not.toContain("Competitive compensation");
    }
  });

  it("puts AI-quoted requirements first and does not repeat the posting lines they quote", () => {
    const quoted = documentRequirements([...PLACEHOLDER_ROWS, {
      requirement_key: "R-003", requirement_type: "FUNCTION", importance: "MUST", extractor_type: "LLM_QUOTED",
      requirement_text: "Product or program leadership for front office trading platforms",
      quote_text: "Product or program leadership for front office trading or investment management platforms",
    }], JOB_DESCRIPTION);
    expect(quoted[0].requirement_key).toBe("R-003");
    expect(quoted.map((row) => row.requirement_text)).not.toContain(
      "Product or program leadership for front office trading or investment management platforms.");
    expect(quoted).toHaveLength(8);
    expect(quoted.some((row) => row.requirement_type === "EMPLOYMENT_TYPE")).toBe(false);
  });

  it("keeps every requirement bullet when the model quotes only a few of them", () => {
    const background = [
      "Experience delivering or integrating trading platforms such as OMS, EMS or PMS.",
      "Ability to translate investment requirements into technology deliverables.",
      "Stakeholder management across investment, technology and data teams.",
      "Product ownership for front office investment technology.",
      "Knowledge of derivatives and the trade lifecycle.",
      "Experience with market data and reference data platforms.",
    ];
    const responsibilities = [
      "Own the roadmap for the portfolio management platform.",
      "Run delivery with engineering teams in two-week increments.",
      "Define controls for trade and position data.",
      "Coordinate vendors for order and execution management.",
      "Report delivery progress to the investment committee.",
      "Lead adoption of the platform across portfolio teams.",
    ];
    const description = [
      "Investment Technology Product Lead",
      "Key Responsibilities",
      ...responsibilities.map((line) => `- ${line}`),
      "Your Background",
      ...background.map((line) => `- ${line}`),
      "Benefits",
      "- Hybrid working and an annual bonus.",
    ].join("\n");
    // The model quoted three bullets, as in the baseline run that dropped the strongest matches.
    const modelRows: StoredRequirementRow[] = [background[3], background[4], background[5]].map((line, index) => ({
      requirement_key: `R-00${index + 1}`, requirement_type: "FUNCTION", importance: "MUST", requirement_text: line,
      extractor_type: "LLM_QUOTED", quote_text: line.replace(/\.$/, ""),
    }));

    const requirements = documentRequirements(modelRows, description);
    const texts = requirements.map((row) => row.requirement_text);
    for (const line of background) {
      expect(texts.filter((text) => text.replace(/\.$/, "") === line.replace(/\.$/, ""))).toHaveLength(1);
    }
    // Duties stay, but similar ones share a theme row.
    for (const line of responsibilities) {
      expect(texts.some((text) => text.toLowerCase().includes(line.replace(/\.$/, "").toLowerCase())), line).toBe(true);
    }
    expect(requirements.filter((row) => row.importance !== "MUST").length).toBeLessThanOrEqual(MAX_OPTIONAL_THEMES);
    const byText = new Map(requirements.map((row) => [row.requirement_text, row]));
    expect(byText.get(background[0])?.importance).toBe("MUST");
    expect(requirements.find((row) => row.requirement_text.startsWith(responsibilities[0].replace(/\.$/, "")))?.importance).toBe("PREFERRED");
    expect(texts).not.toContain("Hybrid working and an annual bonus.");
    expect(new Set(requirements.map((row) => row.requirement_key)).size).toBe(requirements.length);
  });

  it("does not pair a fact with a requirement on one shared word", () => {
    const rows = comparisonFor([
      { requirement_key: "R-001", requirement_type: "EMPLOYMENT_TYPE", importance: "MUST", requirement_text: "Role specifies an employment type." },
      { requirement_key: "R-002", requirement_type: "DOMAIN", importance: "MUST", requirement_text: "Role includes a target technical domain requirement." },
    ], PROFILE).rows as Array<{ evidence: unknown[] }>;
    expect(rows.every((row) => row.evidence.length === 0)).toBe(true);
  });

  it("never shows self-ratings, preference notes or other internal assessments", () => {
    for (const text of [docs.cv, docs.coverLetter]) {
      expect(text).not.toMatch(/Self-rating|\/5\b|not a target/i);
    }
    expect(() => assertNoInternalAssessmentText("The CV", "Capital Markets (Self-rating: 5/5)")).toThrow(/internal assessment/);
    // The builder refuses to emit them even if a comparison still carries one.
    const unfiltered = buildControlledDocuments(comparisonFor(requirements, PROFILE), CONTACT, { asOf: AS_OF });
    expect(unfiltered.cv).not.toMatch(/Self-rating|not a target/i);
  });

  it("gives the major past employment role a full entry ahead of minor ventures, and never lists a course as a job", () => {
    const major = docs.cv.indexOf("### Enterprise Solution Architect and Program Lead at Insurer Investment Management | Apr 2023 – Apr 2025");
    expect(major).toBeGreaterThan(-1);
    expect(docs.cv.indexOf("Designed the derivatives operating model", major)).toBeGreaterThan(major);
    for (const minor of ["Neurodiversity Research Lab", "City University", "Business School Lab"]) {
      expect(docs.cv.indexOf(minor)).toBeGreaterThan(major);
      expect(docs.cv).not.toContain(`### Founder${minor === "Neurodiversity Research Lab" ? "" : " in Residence"} at ${minor}`);
    }
    // The relevant venture gets a full entry; the others share one line.
    expect(section(docs.cv, "Ventures and research")).toContain("### Founder and AI Architect at Venture AI | Aug 2025 – Present");
    expect(section(docs.cv, "Ventures and research")).toMatch(/^- Also: .*Neurodiversity Research Lab.*City University.*Business School Lab/m);
    expect(docs.cv).not.toContain("Certification Sprint");
    // Roles over 20 years old share one summary line; recent employment keeps full entries.
    expect(section(docs.cv, "Earlier career")).toBe("- Earlier roles (1999–2002): Trading House; Tourism Agency");
    expect(docs.cv).toContain("### Associate Director at Boutique Asset Manager | Jul 2019 – Dec 2022");
  });

  it("writes the summary as a single paragraph", () => {
    const summary = section(docs.cv, "Summary");
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).not.toContain("\n");
    expect(summary).not.toMatch(/^- /);
  });

  it("separates education from at most six certifications, ranked by relevance", () => {
    expect(section(docs.cv, "Education").split("\n")).toEqual([
      "- Master of Science in Wealth Management",
      "- Master of Business Administration",
    ]);
    const certifications = section(docs.cv, "Certifications").split("\n");
    expect(certifications.length).toBeLessThanOrEqual(6);
    expect(certifications).not.toContain("- Master of Business Administration");
    expect(certifications).toContain("- Advanced Professional Certificate in Data Science and AI");
    expect(certifications).toContain("- Passed Level I of the CFA Program");
    expect(certifications).not.toContain("- Health Insurance Certification");
  });

  it("uses each fact for at most one requirement line", () => {
    const lines = section(docs.cv, "How my experience matches this role").split("\n");
    const statements = lines.map((line) => line.slice(line.indexOf(": ") + 2));
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(new Set(statements).size).toBe(statements.length);
  });

  it("lets the candidate's role choices override the defaults", () => {
    const chosen = buildControlledDocuments(comparisonFor(requirements, evidence), CONTACT, {
      asOf: AS_OF,
      roleLayout: { "eng-lab": "HIDDEN", "eng-campus": "HIDDEN", "eng-accelerator": "HIDDEN", "eng-crm": "ONE_LINE" },
    });
    expect(chosen.cv).not.toContain("Neurodiversity Research Lab");
    expect(chosen.cv).not.toContain("City University");
    expect(chosen.cv).toContain("- Regional CRM Architect at Consumer Goods Company (Feb 2012 – Sep 2017)");
  });

  it("uses the profile's role layouts and pinned credentials as defaults, which the picker can still override", () => {
    const withPreferences = evidence.map((item): ManualEvidence => {
      if (item.id === "eng-lab") return { ...item, document_layout: "FULL" };
      if (item.id === "eng-venture") return { ...item, document_layout: "HIDDEN" };
      if (item.id === "c-health") return { ...item, always_include: true };
      return item;
    });
    const comparison = comparisonFor(requirements, withPreferences);
    const plan = new Map(planRoles(comparison, { asOf: AS_OF }).map((role) => [role.engagement_id, role]));
    expect(plan.get("eng-lab")).toMatchObject({ default_layout: "FULL", default_source: "PROFILE" });
    expect(plan.get("eng-venture")).toMatchObject({ default_layout: "HIDDEN", default_source: "PROFILE" });
    expect(plan.get("eng-aim")).toMatchObject({ default_layout: "FULL", default_source: "AUTOMATIC" });

    const preferred = buildControlledDocuments(comparison, CONTACT, { asOf: AS_OF });
    expect(preferred.cv).toContain("### Founder at Neurodiversity Research Lab | May 2026 – Present");
    expect(preferred.cv).not.toContain("Venture AI");
    // Pinned even though it is irrelevant to this job, and still within the six-item cap.
    const certifications = section(preferred.cv, "Certifications").split("\n");
    expect(certifications).toContain("- Health Insurance Certification");
    expect(certifications.length).toBeLessThanOrEqual(6);

    const overridden = buildControlledDocuments(comparison, CONTACT, { asOf: AS_OF, roleLayout: { "eng-lab": "ONE_LINE", "eng-venture": "FULL" } });
    expect(overridden.cv).not.toContain("### Founder at Neurodiversity Research Lab");
    expect(overridden.cv).toContain("### Founder and AI Architect at Venture AI");
  });

  it("gives a full entry to every role whose work is cited, however old", () => {
    const withOldRoles = [
      ...evidence,
      engagement("eng-broker", "Delivery Architect at Old Brokerage", "2004-01-01", "2006-06-30", "EMPLOYEE", "PROFESSIONAL_PRODUCTION"),
      fact("f-broker-oms", "Integrated an order management system across 3 custodians for a brokerage.", "eng-broker"),
      fact("f-import-ledger", "Rebuilt the trade documentation ledger for import and export shipments.", "eng-import"),
    ];
    const base = comparisonFor([{ requirement_key: "R-001", requirement_type: "FUNCTION", importance: "MUST",
      requirement_text: "Experience integrating trading platforms such as OMS, EMS or PMS." }], withOldRoles);
    // The model paired the requirement with the 2004 role's fact.
    const comparison = { ...base, rows: (base.rows as Array<Record<string, unknown>>).map((row) => ({ ...row,
      evidence: [{ id: "f-broker-oms", evidence_type: "FACT", label: "f-broker-oms", statement: "Integrated an order management system across 3 custodians for a brokerage." }] })) };
    const plan = new Map(planRoles(comparison, { asOf: AS_OF }).map((role) => [role.engagement_id, role]));
    // Ended more than 20 years ago, so without the citation it would be folded into "Earlier roles".
    expect(plan.get("eng-broker")?.default_layout).toBe("FULL");
    expect(plan.get("eng-import")?.default_layout).toBe("SUMMARISED");

    const docs = buildControlledDocuments(comparison, CONTACT, { asOf: AS_OF, writtenSummary: [
      { text: "Rebuilt the trade documentation ledger for import and export shipments.", evidence_ids: ["f-import-ledger"], requirement_keys: [] },
    ] });
    const experience = section(docs.cv, "Experience");
    expect(experience).toContain("### Delivery Architect at Old Brokerage | Jan 2004 – Jun 2006");
    expect(experience).toContain("- Integrated an order management system across 3 custodians for a brokerage.");
    // Cited only by the summary, the 2002 import role is shown as one line: findable, not promoted.
    expect(experience).not.toContain("Trading House");
    expect(section(docs.cv, "Earlier career")).toContain("Import-Export Coordinator at Trading House");
    expect(section(docs.cv, "Earlier career")).not.toContain("Old Brokerage");
    // The candidate's choice still wins.
    const hidden = buildControlledDocuments(comparison, CONTACT, { asOf: AS_OF, roleLayout: { "eng-broker": "ONE_LINE" } });
    expect(section(hidden.cv, "Experience")).not.toContain("Old Brokerage");
  });

  it("reads a posting pasted from a job site: run-on paragraphs, sub-headings and 'Label. Sentence' bullets", () => {
    // The model quoted two lines, as in the baseline run (quoted_inserted=2).
    const modelRows: StoredRequirementRow[] = [EXCHANGE_REQUIREMENTS[0], EXCHANGE_REQUIREMENTS[3]].map((line, index) => ({
      requirement_key: `R-00${index + 1}`, requirement_type: "FUNCTION", importance: "MUST", requirement_text: line,
      extractor_type: "LLM_QUOTED", quote_text: line,
    }));
    // Every line is parsed with the right importance before optional rows are merged into themes.
    const parsed = documentRequirements(modelRows, EXCHANGE_DESCRIPTION);
    const lines = postingRequirementLines(EXCHANGE_DESCRIPTION);
    const lineTexts = lines.map((row) => row.requirement_text);
    for (const line of [...EXCHANGE_REQUIREMENTS, ...EXCHANGE_RESPONSIBILITIES]) expect(lineTexts).toContain(line);
    const importance = (line: string) => lines.find((row) => row.requirement_text === line)?.importance;
    expect(EXCHANGE_REQUIREMENTS.filter((line) => importance(line) === "MUST")).toHaveLength(7);
    expect(importance(EXCHANGE_REQUIREMENTS[2])).toBe("PREFERRED"); // "is a strong plus"
    expect(importance(EXCHANGE_REQUIREMENTS[8])).toBe("PREFERRED"); // "is a plus"
    expect(EXCHANGE_RESPONSIBILITIES.every((line) => importance(line) === "PREFERRED")).toBe(true);
    // The review keeps every MUST, and the long duty list becomes at most six themes.
    const requirements = parsed;
    const texts = requirements.map((row) => row.requirement_text);
    for (const line of EXCHANGE_REQUIREMENTS.filter((line) => importance(line) === "MUST")) expect(texts).toContain(line);
    expect(requirements.filter((row) => row.importance !== "MUST").length).toBeLessThanOrEqual(MAX_OPTIONAL_THEMES);
    // Sub-headings, the opening paragraphs and the closing "Why this role matters" section are not requirements.
    expect(texts.some((text) => /Stakeholder Management|Why this role|critical market infrastructure|WE RUN MARKETS|partnership role/.test(text))).toBe(false);
  });

  it("falls back to requirement and duty sentences when a posting has no headings", () => {
    const prose = "We are a growing analytics firm in the city. You will lead the data platform team and own its roadmap. "
      + "You have 8+ years of experience in data engineering and cloud platforms. Our office has great coffee and a rooftop.";
    expect(postingRequirementLines(prose).map((row) => [row.requirement_type, row.requirement_text])).toEqual([
      ["POSTING_REQUIREMENT", "You have 8+ years of experience in data engineering and cloud platforms."],
      ["POSTING_RESPONSIBILITY", "You will lead the data platform team and own its roadmap."],
    ]);
  });

  it("reads requirement and responsibility lines from inline headings too", () => {
    expect(postingRequirementLines("Responsibilities: lead the platform roadmap with traders.\nRequirements: eight years in commodity trading technology.")
      .map((row) => [row.requirement_type, row.requirement_text])).toEqual([
      ["POSTING_REQUIREMENT", "eight years in commodity trading technology."],
      ["POSTING_RESPONSIBILITY", "lead the platform roadmap with traders."],
    ]);
  });
});
