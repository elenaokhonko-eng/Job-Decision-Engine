import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import JSZip from "jszip";
import pg from "pg";

import {
  createManualApplicationRouter,
  loadManualProfileEvidence,
  manualQuotedRequirementMode,
} from "../../api/v2/manualApplicationRouter.js";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { importLoadedProfile, type ProfileImportSummary } from "../../profile/importer.js";
import { loadProfile } from "../../profile/loader.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { SYSTEMATIC_TRADING_PRODUCT_LEAD_DESCRIPTION } from "../fixtures/systematicTradingProductLead.js";
import type { EvidencePairer, EvidencePairingInput } from "../../documents/manualEvidencePairing.js";
import { resetManualDocuments } from "../../../scripts/reset_manual_documents.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
const routerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../api/v2/manualApplicationRouter.ts");
const MODEL_KEY_ENV = ["GEMINI_API_KEY", "GEMINI_FLASH_API_KEY", "OPENAI_API_KEY", "REQUIREMENTS_ENABLE_QUOTED"] as const;

// loadCurrentInputs is private, so its job query is read from the router source.
function currentInputsJobQuery(): string {
  const query = /const jobResult = await client\.query<JobRow>\(\s*`([\s\S]*?)`/.exec(readFileSync(routerPath, "utf8"))?.[1];
  if (!query) throw new Error("manualApplicationRouter.ts current-inputs job query was not found.");
  return query;
}

async function importFixtureProfile(pool: pg.Pool, context: WorkspaceContext): Promise<ProfileImportSummary> {
  const profileDir = mkdtempSync(path.join(tmpdir(), "manual-router-profile-"));
  const write = (name: string, body: object) =>
    writeFileSync(path.join(profileDir, name), JSON.stringify({ schema_version: "2.0", profile_key: "manual_router_it", ...body }));
  const engagement = (key: string, role: string, start: string, end: string | null) => ({
    engagement_key: key, organization_legal_name: "Example Org", role_title: role, engagement_type: "EMPLOYEE",
    experience_class: "PROFESSIONAL_PRODUCTION", start_date: start, ...(end ? { end_date: end } : {}), is_current: end === null,
    summary: `${role} engagement summary.`, verification_status: "SELF_ATTESTED",
  });
  const fact = (key: string, engagementKey: string, statement: string, isCurrent: boolean) => ({
    fact_key: key, engagement_key: engagementKey, fact_type: "ACHIEVEMENT", statement, evidence_tier: "PROFESSIONAL_PRODUCTION",
    verification_status: "SELF_ATTESTED", is_current: isCurrent, confidentiality: "PUBLIC",
  });
  const contact = (key: string, kind: string, value: string) => ({
    fact_key: key, fact_type: "CONTACT", statement: `Contact ${kind} for application documents.`,
    structured_value: { kind, value }, evidence_tier: "KNOWLEDGE_ONLY",
    verification_status: "SELF_ATTESTED", is_current: true, confidentiality: "PRIVATE_INTERNAL",
  });
  try {
    write("profile.json", { profile_version: 1, display_name: "Evidence Candidate", status: "ACTIVE" });
    write("engagements.json", { engagements: [
      engagement("eng.current", "Current Architect", "2024-01-01", null),
      engagement("eng.past", "Past Program Lead", "2015-03-01", "2019-06-30"),
    ] });
    write("facts.json", { facts: [
      fact("fact.current.platform", "eng.current", "Designs the current agentic platform architecture in Python.", true),
      fact("fact.past.derivatives", "eng.past", "Led the derivatives operating model programme for a $25B portfolio.", false),
      contact("contact_full_name", "name", "Evidence Candidate"),
      contact("contact_phone", "phone", "+65 6000 0000"),
    ] });
    write("credentials.json", { credentials: [] });
    return await importLoadedProfile(await loadProfile(profileDir), [], pool, { context });
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
}

/** An anonymised profile shaped like the real one: concurrent recent ventures, a course, one major past role. */
async function importShapedProfile(pool: pg.Pool, context: WorkspaceContext): Promise<ProfileImportSummary> {
  const profileDir = mkdtempSync(path.join(tmpdir(), "manual-router-shaped-"));
  const write = (name: string, body: object) =>
    writeFileSync(path.join(profileDir, name), JSON.stringify({ schema_version: "2.0", profile_key: "manual_router_shaped", ...body }));
  const engagement = (key: string, organization: string, role: string, type: string, experienceClass: string, start: string, end: string | null) => ({
    engagement_key: key, organization_legal_name: organization, role_title: role, engagement_type: type, experience_class: experienceClass,
    start_date: start, ...(end ? { end_date: end } : {}), is_current: end === null, summary: `${role} at ${organization}.`, verification_status: "SELF_ATTESTED",
  });
  const fact = (key: string, engagementKey: string | null, factType: string, statement: string) => ({
    fact_key: key, ...(engagementKey ? { engagement_key: engagementKey } : {}), fact_type: factType, statement,
    evidence_tier: "PROFESSIONAL_PRODUCTION", verification_status: "SELF_ATTESTED", is_current: true, confidentiality: "PUBLIC",
  });
  const contact = (key: string, kind: string, value: string) => ({
    fact_key: key, fact_type: "CONTACT", statement: `Contact ${kind} for application documents.`, structured_value: { kind, value },
    evidence_tier: "KNOWLEDGE_ONLY", verification_status: "SELF_ATTESTED", is_current: true, confidentiality: "PRIVATE_INTERNAL",
  });
  try {
    write("profile.json", { profile_version: 1, display_name: "Shaped Candidate", status: "ACTIVE" });
    write("engagements.json", { engagements: [
      { ...engagement("eng.lab", "Neurodiversity Research Lab", "Founder", "RESEARCHER", "APPLIED_PROJECT", "2026-05-01", null), document_layout: "ONE_LINE" },
      engagement("eng.campus", "City University", "Founder in Residence", "FOUNDER_OPERATOR", "PROFESSIONAL_PRODUCTION", "2026-01-01", null),
      { ...engagement("eng.venture", "Venture AI", "Founder and AI Architect", "FOUNDER_OPERATOR", "PROFESSIONAL_PRODUCTION", "2025-08-01", null), document_layout: "FULL" },
      engagement("eng.sprint", "Strategy Consultancy", "Certification Sprint", "RESEARCHER", "COURSE_PROJECT", "2025-07-01", "2025-08-31"),
      engagement("eng.aim", "Insurer Investment Management", "Program Lead", "EMPLOYEE", "PROFESSIONAL_PRODUCTION", "2023-04-01", "2025-04-30"),
      engagement("eng.import", "Trading House", "Coordinator", "EMPLOYEE", "PROFESSIONAL_PRODUCTION", "2000-01-01", "2002-12-31"),
    ] });
    write("facts.json", { facts: [
      fact("fact.aim.front_office", "eng.aim", "ACHIEVEMENT", "Led front office transformation of order management and trade lifecycle workflows for a multi-asset investment management platform."),
      fact("fact.aim.derivatives", "eng.aim", "ACHIEVEMENT", "Designed the derivatives operating model and portfolio management data flows for a $25B investment portfolio."),
      fact("fact.venture.agentic", "eng.venture", "PROJECT", "Architects agentic AI and machine learning tooling on a governed data platform for financial advisers."),
      fact("fact.lab.research", "eng.lab", "PROJECT", "Runs participatory research studies on neurodivergent learning."),
      fact("fact.sprint.change", "eng.sprint", "PROJECT", "Completed a digital transformation and change management certification sprint."),
      fact("fact.domain.capital_markets.5", null, "DOMAIN", "Capital Markets domain expertise (Self-rating: 5/5): institutional trading, derivatives and market data."),
      fact("fact.research.policy.not_target", null, "SKILL", "Pure public policy research: foundational knowledge; not a target work activity."),
      fact("fact.python_sql", null, "TECHNOLOGY", "Uses Python and SQL for data analysis and pipeline prototypes."),
      fact("fact.overview.years", null, "SKILL", "Has 12 years of investment technology and transformation delivery experience."),
      contact("contact_full_name", "name", "Shaped Candidate"),
      contact("contact_phone", "phone", "+65 6000 0001"),
    ] });
    write("credentials.json", { credentials: [
      { credential_key: "cred.msc", credential_name: "Master of Science in Finance", issuer: "Example University", credential_type: "DEGREE", status: "ACTIVE", verification_status: "SELF_ATTESTED" },
      { credential_key: "cred.cloud", credential_name: "Professional Cloud Architect", issuer: "Example Cloud", credential_type: "CERTIFICATION", status: "IN_PROGRESS", verification_status: "SELF_ATTESTED" },
      { credential_key: "cred.cfa_level_1", credential_name: "Passed Level I of the CFA Program", issuer: "CFA Institute", credential_type: "COURSE", status: "ACTIVE", verification_status: "SELF_ATTESTED", always_include_in_documents: true },
    ] });
    return await importLoadedProfile(await loadProfile(profileDir), [], pool, { context });
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
}

let pool: pg.Pool | undefined;
let server: Server | undefined;
let baseUrl = "";
let schemaName = "";
let context: WorkspaceContext | undefined;
let profile: ProfileImportSummary | undefined;
let pairerImpl: EvidencePairer | undefined;
const pairerCalls: EvidencePairingInput[] = [];

describe.skipIf(skipReal)("manual application router (PostgreSQL)", () => {
  beforeAll(async () => {
    schemaName = `manual_router_${crypto.randomUUID().replaceAll("-", "")}`;
    pool = new pg.Pool({ ...pgConnectionConfig(databaseUrl), options: `-c search_path=${schemaName},public` });
    await pool.query(`CREATE SCHEMA ${schemaName}`);
    const client = await pool.connect();
    try {
      await runMigrations(client);
      context = await resolveWorkspaceContext(client);
    } finally {
      client.release();
    }
    profile = await importFixtureProfile(pool, context);
    const workspace = context;
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use(createManualApplicationRouter({
      pool,
      resolveContext: () => workspace,
      evidencePairer: async (input) => {
        pairerCalls.push(input);
        if (!pairerImpl) throw new Error("No evidence pairer is configured for this test.");
        return pairerImpl(input);
      },
    }));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (pool && schemaName) await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
    await pool?.end();
    pool = undefined;
  });

  it("reads readiness columns from a view that exposes them", async () => {
    if (!pool || !context) throw new Error("The manual router test pool is not initialized.");
    const result = await pool.query(currentInputsJobQuery(), [
      context.workspaceId,
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      "a".repeat(64),
    ]);
    const columns = result.fields.map((field) => field.name);

    expect(columns).toEqual(expect.arrayContaining(["readiness_status", "readiness_reason_codes", "recommendation_outcome"]));
  });

  it("offers past-role facts as evidence, linked to their engagement, with plain dates", async () => {
    if (!pool || !context || !profile) throw new Error("The manual router test pool is not initialized.");
    const evidence = await loadManualProfileEvidence(pool, context.workspaceId, profile.profileVersionId);
    const pastRole = evidence.find((item) => item.evidence_type === "ENGAGEMENT" && item.label === "Past Program Lead at Example Org");
    const pastFact = evidence.find((item) => item.statement === "Led the derivatives operating model programme for a $25B portfolio.");

    expect(pastRole?.statement).toContain("(2015-03-01–2019-06-30)");
    expect(pastFact).toMatchObject({ evidence_type: "FACT", engagement_id: pastRole?.id });
    expect(evidence.some((item) => item.statement === "Designs the current agentic platform architecture in Python.")).toBe(true);
    expect(evidence.some((item) => item.statement.includes("+65 6000 0000"))).toBe(false);
  });

  it("goes from a pasted job description to a tailored CV DOCX, warning when AI extraction did not run", async () => {
    if (!profile) throw new Error("The manual router fixture profile is not imported.");
    const candidateProfileId = profile.candidateProfileId;
    const savedEnv = Object.fromEntries(MODEL_KEY_ENV.map((key) => [key, process.env[key]]));
    for (const key of MODEL_KEY_ENV) delete process.env[key];
    try {
      process.env.OPENAI_API_KEY = "configured-for-mode-check";
      expect(manualQuotedRequirementMode()).toBe("with_quoted");
      process.env.REQUIREMENTS_ENABLE_QUOTED = "false";
      expect(manualQuotedRequirementMode()).toBe("deterministic_only");
      for (const key of MODEL_KEY_ENV) delete process.env[key];
      expect(manualQuotedRequirementMode()).toBe("deterministic_only");
      const post = async (route: string, body: object, expectedStatus = 200) => {
        const response = await fetch(`${baseUrl}${route}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        const text = await response.text();
        if (!text.startsWith("{")) throw new Error(`${route} -> ${response.status}: ${text.slice(0, 300)}`);
        const json = JSON.parse(text) as Record<string, any>;
        expect(response.status, JSON.stringify(json)).toBe(expectedStatus);
        return json;
      };
      const posting = (url: string, description: string[]) => ({
        schema_version: "manual_application_v1",
        candidate_profile_id: candidateProfileId,
        source_kind: "PASTED",
        title: "Derivatives Operating Model Lead",
        company: "Example Bank",
        url,
        location: "Singapore",
        description: description.join("\n"),
      });

      // A description without recognisable sections is refused with guidance, not a 500.
      const thin = await post("/compare", posting("https://careers.example.test/thin-posting", [
        "Example Bank is hiring a Derivatives Operating Model Lead in Singapore to work on derivatives.",
        "The successful candidate will join a growing function and partner with many stakeholders across the bank.",
      ]), 422);
      expect(thin.code).toBe("DESCRIPTION_INSUFFICIENT");
      expect(thin.message).toContain("responsibilities");

      const compared = await post("/compare", posting("https://careers.example.test/derivatives-lead", [
        "About the role: Example Bank is hiring a Derivatives Operating Model Lead in Singapore.",
        "Responsibilities: design target operating models and lead front office transformation programmes.",
        "Requirements: at least 8 years of experience in derivatives operations or investment technology.",
        "You must have a bachelor's degree in finance, economics or computer science.",
        "Strong Python skills are preferred.",
      ]));
      expect(compared.document_contact_ready).toBe(true);
      expect(compared.comparison.suitability_warnings.join(" ")).toContain("AI requirement extraction did not run");

      const approved = await post(`/${compared.draft_id}/approve`, { approved: true, comparison_fingerprint: compared.comparison_fingerprint });
      const generated = await post(`/${compared.draft_id}/documents`, { approval_id: approved.approval_id });
      expect(generated.preview.cv).toContain("### Past Program Lead at Example Org | Mar 2015 – Jun 2019");
      expect(generated.preview.cv).toContain("Led the derivatives operating model programme for a $25B portfolio.");

      const download = await fetch(`${baseUrl}/${compared.draft_id}/documents/cv/docx`);
      expect(download.status).toBe(200);
      const payload = await download.json() as { content_base64: string };
      const documentXml = await (await JSZip.loadAsync(Buffer.from(payload.content_base64, "base64")))
        .file("word/document.xml")?.async("string");
      expect(documentXml).toContain("Past Program Lead at Example Org | Mar 2015 – Jun 2019");
      // Each requirement the CV pairs with evidence is written in the job's own words.
      const matched = (compared.comparison.rows as Array<{ requirement: string; evidence: unknown[] }>).filter((row) => row.evidence.length > 0);
      for (const row of matched.slice(0, 8)) {
        expect(documentXml).toContain(row.requirement.trim().replace(/[.;:]+$/, "").replace(/&/g, "&amp;").replace(/'/g, "&apos;"));
      }
    } finally {
      for (const key of MODEL_KEY_ENV) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    }
  });

  it("produces documents without placeholders or self-ratings, with the major past role ahead of minor ventures", async () => {
    if (!pool || !context) throw new Error("The manual router test pool is not initialized.");
    const shaped = await importShapedProfile(pool, context);
    const savedEnv = Object.fromEntries(MODEL_KEY_ENV.map((key) => [key, process.env[key]]));
    // No model key: requirement extraction is deterministic only, as in the failed baseline run.
    for (const key of MODEL_KEY_ENV) delete process.env[key];
    try {
      const post = async (route: string, body: object, expectedStatus = 200) => {
        const response = await fetch(`${baseUrl}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const json = await response.json() as Record<string, any>;
        expect(response.status, JSON.stringify(json)).toBe(expectedStatus);
        return json;
      };
      const compared = await post("/compare", {
        schema_version: "manual_application_v1", candidate_profile_id: shaped.candidateProfileId, source_kind: "PASTED",
        title: "Product Lead - Systematic Commodity Trading", company: "Example Commodities",
        url: "https://careers.example.test/systematic-trading-product-lead", location: "Singapore",
        description: SYSTEMATIC_TRADING_PRODUCT_LEAD_DESCRIPTION,
      });
      const requirementTexts = (compared.comparison.rows as Array<{ requirement: string }>).map((row) => row.requirement);
      expect(requirementTexts).toContain("Working knowledge of derivatives, portfolio management and trade lifecycle operations.");
      expect(requirementTexts.join(" ")).not.toMatch(/Role specifies|Role includes a target|Role requires/);
      expect(JSON.stringify(compared.comparison.evidence)).not.toMatch(/Self-rating|not a target/i);

      // The review screen gets every role with its default layout; courses are not offered as roles.
      const plan = compared.role_plan as Array<{ engagement_id: string; label: string; kind: string; default_layout: string; default_source: string }>;
      const role = (label: string) => plan.find((item) => item.label === label);
      expect(role("Program Lead at Insurer Investment Management")).toMatchObject({ kind: "EMPLOYMENT", default_layout: "FULL" });
      // Profile-level layouts are the defaults, labelled as coming from the profile.
      expect(role("Founder at Neurodiversity Research Lab")).toMatchObject({ kind: "VENTURE", default_layout: "ONE_LINE", default_source: "PROFILE" });
      expect(role("Founder and AI Architect at Venture AI")).toMatchObject({ default_layout: "FULL", default_source: "PROFILE" });
      expect(role("Program Lead at Insurer Investment Management")?.default_source).toBe("AUTOMATIC");
      expect(role("Coordinator at Trading House")?.default_layout).toBe("SUMMARISED");
      expect(plan.some((item) => item.label.includes("Certification Sprint"))).toBe(false);

      const approved = await post(`/${compared.draft_id}/approve`, { approved: true, comparison_fingerprint: compared.comparison_fingerprint });
      const unknownRole = await post(`/${compared.draft_id}/documents`, { approval_id: approved.approval_id, role_layout: { "not-a-role": "HIDDEN" } }, 400);
      expect(JSON.stringify(unknownRole)).toContain("not in the approved comparison");
      const generated = await post(`/${compared.draft_id}/documents`, {
        approval_id: approved.approval_id,
        role_layout: { [role("Founder at Neurodiversity Research Lab")!.engagement_id]: "HIDDEN", [role("Founder in Residence at City University")!.engagement_id]: "HIDDEN" },
      });
      const cv = generated.preview.cv as string;
      for (const text of [cv, generated.preview.cover_letter as string]) {
        expect(text).not.toMatch(/Role specifies|Role includes a target|Self-rating|\/5\b|not a target/i);
      }
      const major = cv.indexOf("### Program Lead at Insurer Investment Management | Apr 2023 – Apr 2025");
      expect(major).toBeGreaterThan(-1);
      expect(cv.indexOf("### Founder and AI Architect at Venture AI")).toBeGreaterThan(major);
      // The candidate hid these two ventures.
      expect(cv).not.toContain("Neurodiversity Research Lab");
      expect(cv).not.toContain("City University");
      expect(cv).not.toContain("Certification Sprint");
      const summary = /## Summary\n([^\n]+)\n\n/.exec(cv);
      expect(summary?.[1]).toBeTruthy();
      expect(cv).toMatch(/## Education\n- Master of Science in Finance(\n|$)/);
      expect(cv).not.toContain("Professional Cloud Architect");
      // Pinned in the profile, so listed regardless of relevance to the job.
      expect(cv).toMatch(/## Certifications\n(- .*\n)*- Passed Level I of the CFA Program/);
      // A course is never evidence that a job requirement is met.
      expect(cv).not.toContain("certification sprint");

      // The test-database reset clears this draft's stored documents, so the same approval generates anew.
      const runIds = async () => (await pool!.query<{ id: string }>(
        "SELECT id FROM manual_application_document_runs WHERE approval_id = $1 ORDER BY id", [approved.approval_id])).rows.map((row) => row.id);
      const before = await runIds();
      const resetClient = await pool!.connect();
      try {
        expect(await resetManualDocuments(resetClient, context!, { draftId: compared.draft_id })).toMatchObject({ runs: 2, artifacts: 4 });
      } finally {
        resetClient.release();
      }
      expect(await runIds()).toEqual([]);
      const regenerated = await post(`/${compared.draft_id}/documents`, { approval_id: approved.approval_id });
      expect(regenerated.artifacts).toHaveLength(4);
      const after = await runIds();
      expect(after).toHaveLength(2);
      expect(after.some((id) => before.includes(id))).toBe(false);
    } finally {
      for (const key of MODEL_KEY_ENV) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    }
  });

  it("tells the candidate to paste LinkedIn postings instead of reporting a fetch failure", async () => {
    const response = await fetch(`${baseUrl}/fetch-description`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://www.linkedin.com/jobs/view/1234567890/", title: "Product Lead", company: "Example Commodities" }),
    });
    const body = await response.json() as { code?: string; message?: string };
    expect(response.status).toBe(422);
    expect(body.message).toContain("LinkedIn job pages can't be fetched");
    expect(body.message).toContain("paste it instead");
  });

  it("keeps generated documents downloadable after the posting gets a new version, but not regenerable", async () => {
    if (!profile) throw new Error("The manual router fixture profile is not imported.");
    const candidateProfileId = profile.candidateProfileId;
    const savedEnv = Object.fromEntries(MODEL_KEY_ENV.map((key) => [key, process.env[key]]));
    for (const key of MODEL_KEY_ENV) delete process.env[key];
    try {
      const post = async (route: string, body: object, expectedStatus = 200) => {
        const response = await fetch(`${baseUrl}${route}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        const json = await response.json() as Record<string, any>;
        expect(response.status, JSON.stringify(json)).toBe(expectedStatus);
        return json;
      };
      const description = [
        "About the role: Example Bank is hiring a Risk Platform Lead in Singapore.",
        "Responsibilities: design target operating models and lead front office transformation programmes.",
        "Requirements: at least 8 years of experience in derivatives operations or investment technology.",
        "You must have a bachelor's degree in finance, economics or computer science.",
      ];
      const posting = (lines: string[]) => ({
        schema_version: "manual_application_v1", candidate_profile_id: candidateProfileId, source_kind: "PASTED",
        title: "Risk Platform Lead", company: "Example Bank", url: "https://careers.example.test/risk-platform-lead",
        location: "Singapore", description: lines.join("\n"),
      });

      const first = await post("/compare", posting(description));
      const approved = await post(`/${first.draft_id}/approve`, { approved: true, comparison_fingerprint: first.comparison_fingerprint });
      await post(`/${first.draft_id}/documents`, { approval_id: approved.approval_id });

      // Re-pasting the posting with an edited description makes a new job version current.
      const second = await post("/compare", posting([...description, "Experience with regulatory reporting is a plus."]));
      expect(second.comparison.canonical_job_id).toBe(first.comparison.canonical_job_id);
      expect(second.comparison.job_version_id).not.toBe(first.comparison.job_version_id);

      for (const [type, format] of [["cv", "docx"], ["cover_letter", "pdf"]]) {
        const download = await fetch(`${baseUrl}/${first.draft_id}/documents/${type}/${format}`);
        const body = await download.json() as Record<string, any>;
        expect(download.status, JSON.stringify(body)).toBe(200);
        expect(crypto.createHash("sha256").update(Buffer.from(body.content_base64, "base64")).digest("hex")).toBe(body.sha256);
      }
      // Currentness still guards generation: the old approval cannot produce new documents.
      const regenerate = await post(`/${first.draft_id}/documents`, { approval_id: approved.approval_id }, 409);
      expect(JSON.stringify(regenerate)).toMatch(/JOB_VERSION_CHANGED|APPROVAL_STALE/);
    } finally {
      for (const key of MODEL_KEY_ENV) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    }
  });

  it("stores one model pairing per comparison, reuses it through approve and generate, and records failures", async () => {
    if (!pool || !profile) throw new Error("The manual router test pool is not initialized.");
    const candidateProfileId = profile.candidateProfileId;
    const savedEnv = Object.fromEntries(MODEL_KEY_ENV.map((key) => [key, process.env[key]]));
    for (const key of MODEL_KEY_ENV) delete process.env[key];
    process.env.OPENAI_API_KEY = "configured-for-mode-check";
    process.env.REQUIREMENTS_ENABLE_QUOTED = "false";
    try {
      const post = async (route: string, body: object, expectedStatus = 200) => {
        const response = await fetch(`${baseUrl}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const json = await response.json() as Record<string, any>;
        expect(response.status, JSON.stringify(json)).toBe(expectedStatus);
        return json;
      };
      const posting = (url: string, title: string) => ({
        schema_version: "manual_application_v1", candidate_profile_id: candidateProfileId, source_kind: "PASTED",
        title, company: "Example Bank", url, location: "Singapore",
        description: [
          "Responsibilities: lead the derivatives operating model for front office portfolios.",
          "Requirements: hands-on experience operating Azure cloud infrastructure today.",
          "Experience leading derivatives operating model programmes for large portfolios is required.",
        ].join("\n"),
      });

      // The model pairs the derivatives programme with the operating-model requirement only.
      pairerCalls.length = 0;
      pairerImpl = async (input) => {
        const derivatives = input.evidence.find((item) => item.statement.includes("derivatives operating model"));
        const requirement = input.requirements.find((item) => item.requirement_text.includes("derivatives operating model programmes"));
        const cloud = input.requirements.find((item) => item.requirement_text.includes("Azure"));
        if (!derivatives || !requirement || !cloud) throw new Error("Expected requirement or evidence missing from the pairing input.");
        return { provider: "test", model: "fixture-pairer", pairs: [
          { requirement_key: requirement.requirement_key, evidence_id: derivatives.id, confidence: 0.92, justification: "Led a derivatives operating model programme." },
          { requirement_key: cloud.requirement_key, evidence_id: derivatives.id, confidence: 0.3, justification: "Not cloud work." },
        ] };
      };
      const compared = await post("/compare", posting("https://careers.example.test/pairing-ok", "Derivatives Operating Model Programme Lead"));
      expect(pairerCalls).toHaveLength(1);
      expect(pairerCalls[0].evidence.every((item) => item.evidence_type !== "ENGAGEMENT")).toBe(true);
      const rows = compared.comparison.rows as Array<{ requirement: string; evidence: Array<{ statement: string; confidence?: number; justification?: string }>; comparison_method: string }>;
      const derivativesRow = rows.find((row) => row.requirement.includes("derivatives operating model programmes"))!;
      expect(derivativesRow.evidence[0]).toMatchObject({ confidence: 0.92, justification: "Led a derivatives operating model programme." });
      expect(rows.find((row) => row.requirement.includes("Azure"))!.evidence).toEqual([]);
      expect(rows.every((row) => row.comparison_method === "model-judged pairing; advisory evidence only")).toBe(true);
      expect(compared.comparison.fit).toMatchObject({ verdict: expect.any(String), must_total: expect.any(Number) });
      expect(compared.comparison.suitability_warnings.join(" ")).not.toContain("AI evidence pairing");
      const stored = await pool.query("SELECT status, model, jsonb_array_length(pairs) AS pairs FROM manual_evidence_pairings WHERE job_version_id = $1",
        [compared.comparison.job_version_id]);
      expect(stored.rows).toEqual([{ status: "COMPLETED", model: "fixture-pairer", pairs: 1 }]);

      // Approve and generate rebuild the same comparison from the stored pairs, without calling the model again.
      const approved = await post(`/${compared.draft_id}/approve`, { approved: true, comparison_fingerprint: compared.comparison_fingerprint });
      const generated = await post(`/${compared.draft_id}/documents`, { approval_id: approved.approval_id });
      expect(generated.preview.cv).toContain("Led the derivatives operating model programme for a $25B portfolio.");
      expect(generated.preview.cv).not.toContain("Azure");
      const again = await post("/compare", posting("https://careers.example.test/pairing-ok", "Derivatives Operating Model Programme Lead"));
      expect(again.comparison_fingerprint).toBe(compared.comparison_fingerprint);
      expect(pairerCalls).toHaveLength(1);

      // A failed pairing is recorded, shown as a warning, and the comparison falls back to word matching.
      pairerImpl = async () => { throw new Error("provider unavailable"); };
      const failed = await post("/compare", posting("https://careers.example.test/pairing-failed", "Derivatives Operating Model Programme Lead Failed"));
      expect(failed.comparison.suitability_warnings.join(" ")).toContain("AI evidence pairing failed (provider unavailable)");
      expect((failed.comparison.rows as Array<{ comparison_method: string }>).every((row) => row.comparison_method === "distinctive-term overlap; potential evidence only")).toBe(true);
      const failedRow = await pool.query("SELECT status, error_message FROM manual_evidence_pairings WHERE job_version_id = $1", [failed.comparison.job_version_id]);
      expect(failedRow.rows[0]).toMatchObject({ status: "FAILED", error_message: "provider unavailable" });
    } finally {
      pairerImpl = undefined;
      for (const key of MODEL_KEY_ENV) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    }
  });

  it("checks download membership without a read-only transaction error", async () => {
    const response = await fetch(`${baseUrl}/${crypto.randomUUID()}/documents/CV/DOCX`);
    const body = await response.json() as { error?: { code?: string } | string };

    expect(response.status).toBe(404);
    expect(JSON.stringify(body)).toContain("NOT_FOUND");
  });
});
