import fs from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

import { SourceNameSchema, SourcePluginSchema } from "../../contracts/index.js";
import {
  LinkedInSavedExportFileError,
  LinkedInSavedJobItemSchema,
  firstNonEmptyLine,
  isLegacyPlaceholderDescription,
  linkedInWorkplaceTypeFromLocation,
  parseLinkedInSavedExport,
  parseLinkedInSavedExportText,
  savedPostingMatchesDiscovery,
  type LinkedInSavedJob,
} from "../../ingestion/linkedInSavedExport.js";
import { savedPostingDerivedObservation } from "../../ingestion/linkedInSavedContent.js";
import { linkedInSavedImportExitCode, type LinkedInSavedImportReport } from "../../ingestion/linkedInSavedImport.js";
import { parseImportLinkedInSavedArguments } from "../../../scripts/import_linkedin_saved.js";

// Synthetic fixtures only: no real postings or personal data.
const DESCRIPTION = [
  "About the role: Example Synthetic Analytics is hiring a data engineer for its regional platform team.",
  "Responsibilities: you will build data pipelines, review designs and support the analytics squads.",
  "Requirements: experience with SQL, Python and cloud data platforms, plus clear stakeholder communication.",
].join("\n");

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Synthetic Data Engineer",
    company: "Example Synthetic Analytics",
    url: "https://www.linkedin.com/jobs/view/4200000001/?trk=saved",
    description: DESCRIPTION,
    descriptionStatus: "OK",
    location: "Example City (Hybrid)",
    linkedinJobId: "4200000001",
    exportedAt: "2026-11-01T00:00:00.000Z",
    sourcePage: "https://www.linkedin.com/my-items/saved-jobs/",
    ...overrides,
  };
}

function valid(result: ReturnType<typeof parseLinkedInSavedExport>, index = 0): LinkedInSavedJob {
  const job = result.valid.find((candidate) => candidate.index === index);
  if (!job) throw new Error(`Item ${index} was not valid: ${JSON.stringify(result.invalid)}`);
  return job;
}

describe("LinkedIn saved-jobs export parsing", () => {
  it("derives the job id and canonical URL and keeps missing facts missing", () => {
    const result = parseLinkedInSavedExport([
      item(),
      item({
        url: "https://www.linkedin.com/jobs/collections/saved/?currentJobId=4200000002",
        linkedinJobId: undefined,
        location: undefined,
        salary: null,
        title: "Synthetic Analyst",
      }),
    ]);
    expect(result.invalid).toEqual([]);
    const first = valid(result, 0);
    expect(first).toMatchObject({
      linkedInJobId: "4200000001",
      canonicalUrl: "https://www.linkedin.com/jobs/view/4200000001",
      location: "Example City (Hybrid)",
      workplaceType: "HYBRID",
      salary: null,
      postedAt: null,
    });
    expect(valid(result, 1)).toMatchObject({
      linkedInJobId: "4200000002",
      location: null,
      workplaceType: "UNKNOWN",
      salary: null,
    });
    // exportedAt is not part of the hashed payload, so a later re-export of the same job dedupes.
    const reExported = parseLinkedInSavedExport([item({ exportedAt: "2026-11-05T00:00:00.000Z" })]);
    expect(valid(reExported).rawPayload).toEqual(first.rawPayload);
  });

  it("reports each invalid item with its index and reason without dropping the valid ones", () => {
    const result = parseLinkedInSavedExport([
      item(),
      item({ url: "https://example.test/jobs/view/4200000003/", linkedinJobId: "4200000003" }),
      item({ url: "https://www.linkedin.com/jobs/search/", linkedinJobId: undefined }),
      item({ linkedinJobId: "4299999999" }),
      item({ description: "" }),
      item({ descriptionStatus: "FETCH_FAILED", description: null, url: "https://www.linkedin.com/jobs/view/4200000004/", linkedinJobId: null }),
      item({ unexpected: true }),
      "not an object",
    ]);
    expect(result.valid.map((job) => job.index)).toEqual([0]);
    expect(result.invalid.map((entry) => entry.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.invalid.find((entry) => entry.index === 1)?.reason).toMatch(/linkedin\.com/);
    expect(result.invalid.find((entry) => entry.index === 2)?.reason).toMatch(/no LinkedIn job id/);
    expect(result.invalid.find((entry) => entry.index === 3)?.reason).toMatch(/does not match/);
    expect(result.invalid.find((entry) => entry.index === 4)?.reason).toMatch(/description is missing/);
    expect(result.invalid.find((entry) => entry.index === 5)?.reason).toMatch(/FETCH_FAILED/);
    expect(result.invalid.find((entry) => entry.index === 6)?.reason).toMatch(/unknown field\(s\): unexpected/);
    expect(result.invalid.find((entry) => entry.index === 7)?.reason).toMatch(/JSON object/);
  });

  it("reads the earlier snippet's placeholders as missing, never as content", () => {
    const legacy = (overrides: Record<string, unknown>) => ({
      title: "Synthetic Data Engineer",
      company: "Example Synthetic Analytics",
      url: "https://www.linkedin.com/jobs/view/4200000010/",
      location: "Singapore",
      description: DESCRIPTION,
      ...overrides,
    });
    const result = parseLinkedInSavedExport([
      legacy({ title: "Synthetic Data Engineer\nSynthetic Data Engineer\nwith verification" }),
      legacy({ url: "https://www.linkedin.com/jobs/view/4200000011/", company: "Unknown Company" }),
      legacy({ url: "https://www.linkedin.com/jobs/view/4200000012/", description: "Full description not available. Please visit job link to apply." }),
      legacy({ url: "https://www.linkedin.com/jobs/view/4200000013/", description: "Failed to fetch description automatically." }),
      legacy({ url: "https://www.linkedin.com/jobs/view/4200000014/", location: "Singapore (Hybrid)" }),
    ]);
    const first = valid(result, 0);
    expect(first.title).toBe("Synthetic Data Engineer");
    expect(first.location).toBeNull();
    expect(first.notes).toEqual(["TITLE_TRIMMED_TO_FIRST_LINE", "LEGACY_DEFAULT_LOCATION_DROPPED"]);
    expect(first.rawPayload).toMatchObject({ legacy_export_shape: true });
    expect(result.invalid.map((entry) => entry.index)).toEqual([1, 2, 3]);
    expect(result.invalid[0]?.reason).toMatch(/company is missing/);
    expect(result.invalid[1]?.reason).toMatch(/placeholder/);
    expect(result.invalid[2]?.reason).toMatch(/placeholder/);
    expect(valid(result, 4)).toMatchObject({ location: "Singapore (Hybrid)", workplaceType: "HYBRID", notes: [] });
    // A new-shape export states descriptionStatus, so an explicit "Singapore" is real data.
    expect(valid(parseLinkedInSavedExport([item({ location: "Singapore" })])).location).toBe("Singapore");
    expect(isLegacyPlaceholderDescription("Full description not available.")).toBe(true);
    expect(isLegacyPlaceholderDescription(DESCRIPTION)).toBe(false);
    expect(firstNonEmptyLine("\n  Title  \nTitle\n")).toBe("Title");
  });

  it("stages an identical duplicate once and rejects a conflicting one", () => {
    const result = parseLinkedInSavedExport([item(), item(), item({ title: "Different Synthetic Title" })]);
    expect(result.valid).toHaveLength(1);
    expect(result.duplicatesInFile).toEqual([{ index: 1, firstIndex: 0, linkedInJobId: "4200000001" }]);
    expect(result.invalid).toEqual([{ index: 2, reason: expect.stringMatching(/different content/) }]);
  });

  it("treats a non-array, empty or malformed file as a file-level error", () => {
    expect(() => parseLinkedInSavedExport({ jobs: [] })).toThrow(LinkedInSavedExportFileError);
    expect(() => parseLinkedInSavedExport([])).toThrow(/no saved jobs/);
    expect(() => parseLinkedInSavedExportText("{not json")).toThrow(/not valid JSON/);
    expect(parseLinkedInSavedExportText(String.fromCharCode(0xfeff) + JSON.stringify([item()])).valid).toHaveLength(1);
  });

  it("matches a Gmail card only when title and employer agree", () => {
    expect(savedPostingMatchesDiscovery(
      { title: "Synthetic Data Engineer", companyName: "Example Synthetic" },
      { title: "synthetic data-engineer", companyName: "Example Synthetic Analytics" },
    )).toEqual({ matches: true });
    expect(savedPostingMatchesDiscovery(
      { title: "Synthetic Data Engineer", companyName: "Unknown Company" },
      { title: "Synthetic Data Engineer", companyName: "Example Synthetic Analytics" },
    )).toEqual({ matches: true });
    expect(savedPostingMatchesDiscovery(
      { title: "Synthetic Data Engineer II", companyName: "Example Synthetic" },
      { title: "Synthetic Data Engineer", companyName: "Example Synthetic" },
    )).toEqual({ matches: false, reason: "TITLE_MISMATCH" });
    expect(savedPostingMatchesDiscovery(
      { title: "Synthetic Data Engineer", companyName: "Other Example Corp" },
      { title: "Synthetic Data Engineer", companyName: "Example Synthetic" },
    )).toEqual({ matches: false, reason: "COMPANY_MISMATCH" });
    expect(linkedInWorkplaceTypeFromLocation("Example City (On-site)")).toBe("ONSITE");
    expect(linkedInWorkplaceTypeFromLocation("Remote work available")).toBe("UNKNOWN");
  });

  it("builds a derived posting without an HTTP receipt and with export provenance", () => {
    const derived = savedPostingDerivedObservation("00000000-0000-4000-8000-000000000001", {
      observationId: "00000000-0000-4000-8000-000000000002",
      linkedInJobId: "4200000001",
      canonicalUrl: "https://www.linkedin.com/jobs/view/4200000001",
      title: "Synthetic Data Engineer",
      companyName: "Example Synthetic Analytics",
      description: DESCRIPTION,
      location: null,
      compensation: null,
      postedAt: null,
      importedAt: "2026-11-01T00:00:00.000Z",
      exportPayloadHash: "a".repeat(64),
    });
    expect(derived).toMatchObject({
      sourceName: "LINKEDIN_SAVED",
      sourceExternalId: "linkedin-job:4200000001",
      derivedFromObservationId: "00000000-0000-4000-8000-000000000001",
      retrievedAt: "2026-11-01T00:00:00.000Z",
      workplaceTypeRaw: "UNKNOWN",
    });
    expect(derived).not.toHaveProperty("locationRaw");
    expect(derived.rawPayload).toMatchObject({
      source_content_status: "COMPLETE",
      content_provenance: "LINKEDIN_SAVED_EXPORT",
      imported_at: "2026-11-01T00:00:00.000Z",
      content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(derived.rawPayload).not.toHaveProperty("source_evidence");
  });

  it("fails the command when any item is invalid or failed", () => {
    const report = (invalid: number, failed: number, normalizeSeedError: string | null = null) => ({
      totals: { invalid, failed },
      normalizeSeedError,
    }) as unknown as LinkedInSavedImportReport;
    expect(linkedInSavedImportExitCode(report(0, 0))).toBe(0);
    expect(linkedInSavedImportExitCode(report(1, 0))).toBe(1);
    expect(linkedInSavedImportExitCode(report(0, 1))).toBe(1);
    expect(linkedInSavedImportExitCode(report(0, 0, "seed failed"))).toBe(1);
  });

  it("parses the command line", () => {
    expect(parseImportLinkedInSavedArguments(["export.json", "--dry-run"])).toEqual({ filePath: "export.json", dryRun: true });
    expect(parseImportLinkedInSavedArguments(["--workspace-key", "ws", "export.json"])).toEqual({
      filePath: "export.json",
      dryRun: false,
      workspaceKey: "ws",
    });
    expect(() => parseImportLinkedInSavedArguments([])).toThrow(/Usage/);
    expect(() => parseImportLinkedInSavedArguments(["a.json", "b.json"])).toThrow(/exactly one/);
    expect(() => parseImportLinkedInSavedArguments(["a.json", "--apply"])).toThrow(/Unsupported/);
  });
});

describe("LinkedIn saved-jobs source registration and browser snippet", () => {
  it("registers LINKEDIN_SAVED as a manual, user-supplied source", () => {
    expect(SourceNameSchema.parse("LINKEDIN_SAVED")).toBe("LINKEDIN_SAVED");
    const manifest = SourcePluginSchema.parse(loadYaml(fs.readFileSync(
      path.resolve(process.cwd(), "config", "source-plugins", "linkedin_saved.yml"),
      "utf8",
    )));
    expect(manifest).toMatchObject({
      source_key: "linkedin_saved",
      kind: "manual_import",
      schedule: { enabled: false },
      compliance: { access_basis: "user_supplied", authenticated_scraping: false },
    });
    expect(manifest.availability?.full_posting_hosts ?? []).toEqual([]);
  });

  it("emits exactly the importer's fields and never handles cookies or fabricates defaults", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "scripts", "linkedin", "export_saved_jobs.console.js"), "utf8");
    const snippet = source.replace(/\/\*[\s\S]*?\*\//, "");
    expect(source).toMatch(/human pace/);
    expect(snippet).not.toMatch(/document\.cookie|li_at|localStorage\.getItem\(["']li_/);
    expect(snippet).not.toMatch(/Unknown Company|["']Singapore["']|Full description not available|Failed to fetch description/);
    expect(snippet).toMatch(/status === 429/);
    // LinkedIn moved Saved jobs to the Job Tracker; both page paths must be accepted.
    const pagePattern = snippet.match(/if \(!(\/.*?\/)\.test\(location\.pathname\)\)/)?.[1] ?? "";
    const pathCheck = new RegExp(pagePattern.slice(1, -1));
    expect(pathCheck.test("/jobs-tracker/")).toBe(true);
    expect(pathCheck.test("/my-items/saved-jobs/")).toBe(true);
    expect(pathCheck.test("/jobs/search/")).toBe(false);
    const emitted = snippet.match(/state\.jobs\[id\] = \{([\s\S]*?)\};/)?.[1] ?? "";
    const keys = [...emitted.matchAll(/^\s*([a-zA-Z]+)[:,]/gm)].map((match) => match[1]).sort();
    const schemaKeys = Object.keys(LinkedInSavedJobItemSchema.shape).filter((key) => !["salary", "postedAt"].includes(key)).sort();
    expect(keys).toEqual(schemaKeys);
  });

  it("splits a Job Tracker card's single text run into title, company and location", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "scripts", "linkedin", "export_saved_jobs.console.js"), "utf8");
    const body = source.match(/function parseTrackerCard\(text\) \{[\s\S]*?\n {2}\}\n/)?.[0] ?? "";
    const clean = (value: string) => (value || "").replace(/\s+/g, " ").trim();
    const parseTrackerCard = new Function("clean", `${body}; return parseTrackerCard;`)(clean);

    expect(parseTrackerCard("Data Engineer (Verified job)Data Engineer Example Co · Singapore (Hybrid)Posted 2w ago"))
      .toEqual({ title: "Data Engineer", company: "Example Co", location: "Singapore (Hybrid)" });
    expect(parseTrackerCard("Platform EngineerExample Co · Singapore (Remote)Reposted 3w ago"))
      .toEqual({ title: "Platform EngineerExample Co", company: null, location: "Singapore (Remote)" });
    expect(parseTrackerCard("Analyst")).toEqual({ title: "Analyst", company: null, location: null });
  });

  it("reads descriptions from the public job page, requested without the session", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "scripts", "linkedin", "export_saved_jobs.console.js"), "utf8");
    expect(source).toMatch(/fetch\(job\.url, \{ credentials: "omit"/);
    expect(source).not.toMatch(/credentials: "include"/);
    expect(source).toMatch(/\.show-more-less-html__markup/);
    expect(source).toMatch(/xhr\.responseType = "document"/);
  });
});
