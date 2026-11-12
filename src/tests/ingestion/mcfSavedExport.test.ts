import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

import { SourceNameSchema, SourcePluginSchema } from "../../contracts/index.js";
import {
  McfSavedExportFileError,
  McfSavedJobItemSchema,
  isMcfPlaceholderCompany,
  isMcfPlaceholderDescription,
  mcfCanonicalJobUrl,
  mcfCompensationText,
  mcfEmploymentTypeRaw,
  mcfJobUuidFromUrl,
  parseMcfSavedExport,
  parseMcfSavedExportText,
  type McfSavedJob,
} from "../../ingestion/mcfSavedExport.js";
import { mcfSavedPostingDerivedObservation } from "../../ingestion/mcfSavedContent.js";
import { mcfSavedImportExitCode, type McfSavedImportReport } from "../../ingestion/mcfSavedImport.js";
import { parseImportMcfSavedArguments } from "../../../scripts/import_mcf_saved.js";

// Synthetic fixtures only: no real postings, employers or personal data.
const UUID_A = "0123456789abcdef0123456789abcdef";
const UUID_B = "fedcba9876543210fedcba9876543210";
const DESCRIPTION = [
  "About the role: Example Synthetic Analytics is hiring a data engineer for its regional platform team.",
  "Responsibilities: you will build data pipelines, review designs and support the analytics squads.",
  "Requirements: experience with SQL, Python and cloud data platforms, plus clear stakeholder communication.",
].join("\n");

function jobUrl(uuid: string, category: string | null = "information-technology"): string {
  return `https://www.mycareersfuture.gov.sg/job/${category ? `${category}/` : ""}synthetic-data-engineer-example-synthetic-analytics-${uuid}`;
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Synthetic Data Engineer",
    company: "EXAMPLE SYNTHETIC ANALYTICS PTE. LTD.",
    url: `${jobUrl(UUID_A)}?source=saved`,
    description: DESCRIPTION,
    descriptionStatus: "OK",
    location: "1 Example Street, Singapore 000001",
    salary: { min: 6500, max: 9000, currency: "SGD", period: "Monthly" },
    employmentType: "Permanent, Full Time",
    postedAt: "2026-11-01",
    expiresAt: "2026-12-01",
    mcfJobUuid: UUID_A,
    exportedAt: "2026-11-02T00:00:00.000Z",
    sourcePage: "https://www.mycareersfuture.gov.sg/saved-jobs",
    ...overrides,
  };
}

function valid(result: ReturnType<typeof parseMcfSavedExport>, index = 0): McfSavedJob {
  const job = result.valid.find((candidate) => candidate.index === index);
  if (!job) throw new Error(`Item ${index} was not valid: ${JSON.stringify(result.invalid)}`);
  return job;
}

describe("MCF job UUID and canonical URL", () => {
  it("derives the trailing 32-hex UUID with or without the category folder", () => {
    expect(mcfJobUuidFromUrl(jobUrl(UUID_A))).toBe(UUID_A);
    expect(mcfJobUuidFromUrl(jobUrl(UUID_A, null))).toBe(UUID_A);
    expect(mcfJobUuidFromUrl(`${jobUrl(UUID_A)}/?source=alert#apply`)).toBe(UUID_A);
    expect(mcfJobUuidFromUrl(jobUrl(UUID_A).toUpperCase().replace("HTTPS://WWW.MYCAREERSFUTURE.GOV.SG", "https://www.mycareersfuture.gov.sg"))).toBe(UUID_A);
    expect(mcfJobUuidFromUrl(`https://www.mycareersfuture.gov.sg/job/${UUID_A}`)).toBe(UUID_A);
  });

  it("unwraps SES click tracking and rejects non-posting links", () => {
    const wrapped = `https://abc123.r.ap-southeast-1.awstrack.me/L0/${encodeURIComponent(jobUrl(UUID_B))}/1/0100-synthetic-signature`;
    expect(mcfJobUuidFromUrl(wrapped)).toBe(UUID_B);
    expect(mcfJobUuidFromUrl(`https://www.mycareersfuture.gov.sg/jobalert/remove/${UUID_A}`)).toBeNull();
    expect(mcfJobUuidFromUrl("https://www.mycareersfuture.gov.sg/search?search=data")).toBeNull();
    expect(mcfJobUuidFromUrl(`https://careers.example.com/job/it/role-${UUID_A}`)).toBeNull();
    expect(mcfJobUuidFromUrl(`https://www.mycareersfuture.gov.sg/job/it/role-${UUID_A}0`)).toBeNull();
    expect(mcfJobUuidFromUrl("not a url")).toBeNull();
  });

  it("keeps the canonical URL as given, on www, without the query string", () => {
    expect(mcfCanonicalJobUrl(`${jobUrl(UUID_A)}/?source=saved`)).toBe(jobUrl(UUID_A));
    expect(mcfCanonicalJobUrl(jobUrl(UUID_A, null).replace("www.", ""))).toBe(jobUrl(UUID_A, null));
    expect(mcfCanonicalJobUrl(jobUrl(UUID_A).replace("https:", "http:"))).toBeNull();
  });
});

describe("MCF saved-jobs export parsing", () => {
  it("validates an item, derives identity and keeps unknown facts null", () => {
    const result = parseMcfSavedExport([
      item(),
      item({
        url: jobUrl(UUID_B, null),
        mcfJobUuid: UUID_B.toUpperCase(),
        location: null,
        salary: undefined,
        employmentType: undefined,
        postedAt: null,
        expiresAt: undefined,
        title: "Synthetic Analyst",
      }),
    ]);
    expect(result.invalid).toEqual([]);
    expect(valid(result, 0)).toMatchObject({
      mcfJobUuid: UUID_A,
      canonicalUrl: jobUrl(UUID_A),
      company: "EXAMPLE SYNTHETIC ANALYTICS PTE. LTD.",
      location: "1 Example Street, Singapore 000001",
      compensation: "SGD 6,500 - 9,000 per month",
      employmentTypeRaw: "UNKNOWN",
      postedAt: "2026-11-01",
      expiresAt: "2026-12-01",
    });
    expect(valid(result, 1)).toMatchObject({
      mcfJobUuid: UUID_B,
      canonicalUrl: jobUrl(UUID_B, null),
      // MCF lists only jobs in Singapore: a hidden address is recorded as the country.
      location: "Singapore",
      locationBasis: "MCF_SINGAPORE_ONLY_PORTAL",
      salary: null,
      compensation: null,
      employmentType: null,
      employmentTypeRaw: "UNKNOWN",
      postedAt: null,
      expiresAt: null,
    });
    // exportedAt is not part of the hashed payload, so a later re-export of the same job dedupes.
    const reExported = parseMcfSavedExport([item({ exportedAt: "2026-11-05T00:00:00.000Z" })]);
    expect(valid(reExported).rawPayload).toEqual(valid(result, 0).rawPayload);
    expect(valid(result, 0).rawPayload).toMatchObject({
      content_provenance: "MCF_SAVED_EXPORT",
      mcf_job_uuid: UUID_A,
      canonical_url: jobUrl(UUID_A),
    });
    // An exported address keeps its earlier payload; only a hidden one records the basis.
    expect(valid(result, 0)).toMatchObject({ location: "1 Example Street, Singapore 000001", locationBasis: "EXPORTED" });
    expect(valid(result, 0).rawPayload).not.toHaveProperty("location_basis");
    expect(valid(result, 1).rawPayload).toMatchObject({ location_basis: "MCF_SINGAPORE_ONLY_PORTAL", location: "Singapore" });
    expect((valid(result, 1).rawPayload.exported_item as { location: unknown }).location).toBeNull();
  });

  it("rejects recruiter contact data, raw API fields and other unknown keys", () => {
    const result = parseMcfSavedExport([
      item({ metadata: { emailRecipient: "recruiter@example.invalid" } }),
      item({ emailRecipient: "recruiter@example.invalid" }),
      item({ salary: { min: 1, max: 2, currency: "SGD", period: "Monthly", isHideSalary: false } }),
    ]);
    expect(result.valid).toEqual([]);
    expect(result.invalid.map((entry) => entry.reason)).toEqual([
      "unknown field(s): metadata",
      "unknown field(s): emailRecipient",
      "unknown field(s): isHideSalary",
    ]);
    expect(Object.keys(McfSavedJobItemSchema.shape).sort()).toEqual([
      "availabilityEvidence", "availabilityStatus", "company", "description", "descriptionStatus", "employmentType",
      "expiresAt", "exportedAt", "location", "mcfJobUuid", "originalPostedAt", "postedAt", "postingCheckedAt", "postingRecheckFailedAt", "postingRecheckFailure", "salary",
      "sourcePage", "title", "url",
    ]);
  });

  it("rejects placeholders, missing content and identity mismatches with a reason", () => {
    const result = parseMcfSavedExport([
      item({ company: "Company Undisclosed" }),
      item({ company: null }),
      item({ description: "Description not available." }),
      item({ description: "Failed to fetch description automatically." }),
      item({ descriptionStatus: "FETCH_FAILED", description: null }),
      item({ descriptionStatus: null }),
      item({ descriptionStatus: undefined }),
      item({ mcfJobUuid: UUID_B }),
      item({ mcfJobUuid: "1234" }),
      item({ url: `https://careers.example.com/job/${UUID_A}` }),
      item({ url: "https://www.mycareersfuture.gov.sg/search?search=data" }),
      item({ salary: { min: 9000, max: 6500, currency: "SGD", period: "Monthly" } }),
      item({ salary: { min: null, max: null, currency: "SGD", period: "Monthly" } }),
      item({ postedAt: "yesterday" }),
      item({ title: "   " }),
    ]);
    expect(result.valid).toEqual([]);
    const reasons = result.invalid.map((entry) => entry.reason);
    expect(reasons[0]).toMatch(/company is missing/);
    expect(reasons[1]).toMatch(/company is missing/);
    expect(reasons[2]).toMatch(/placeholder/);
    expect(reasons[3]).toMatch(/placeholder/);
    expect(reasons[4]).toMatch(/descriptionStatus=FETCH_FAILED/);
    expect(reasons[5]).toMatch(/not fetched yet/);
    expect(reasons[6]).toMatch(/descriptionStatus is required/);
    expect(reasons[7]).toMatch(/does not match the job id/);
    expect(reasons[8]).toMatch(/32 hexadecimal/);
    expect(reasons[9]).toMatch(/mycareersfuture\.gov\.sg job URL/);
    expect(reasons[10]).toMatch(/\/job\/<category>/);
    expect(reasons[11]).toMatch(/min must not exceed/);
    expect(reasons[12]).toMatch(/omit salary/);
    expect(reasons[13]).toMatch(/ISO date/);
    expect(reasons[14]).toMatch(/title must not be empty/);
  });

  it("stages a repeated job once and rejects a conflicting repeat", () => {
    const result = parseMcfSavedExport([item(), item({ exportedAt: "2026-11-03T00:00:00.000Z" }), item({ title: "Synthetic Other Role" })]);
    expect(result.valid).toHaveLength(1);
    expect(result.duplicatesInFile).toEqual([{ index: 1, firstIndex: 0, mcfJobUuid: UUID_A }]);
    expect(result.invalid).toEqual([{ index: 2, reason: expect.stringMatching(/appears again/) }]);
  });

  it("treats file-level problems as errors", () => {
    expect(() => parseMcfSavedExport({ jobs: [] })).toThrow(McfSavedExportFileError);
    expect(() => parseMcfSavedExport([])).toThrow(/no saved jobs/);
    expect(() => parseMcfSavedExportText("{not json")).toThrow(/not valid JSON/);
    const withBom = String.fromCharCode(0xfeff) + JSON.stringify([item()]);
    expect(parseMcfSavedExportText(withBom).valid).toHaveLength(1);
  });

  it("maps employment type and salary text without inventing values", () => {
    expect(mcfEmploymentTypeRaw("Permanent")).toBe("PERMANENT");
    expect(mcfEmploymentTypeRaw("Contract, Temporary")).toBe("CONTRACT");
    expect(mcfEmploymentTypeRaw("Permanent, Contract")).toBe("UNKNOWN");
    expect(mcfEmploymentTypeRaw("Full Time")).toBe("UNKNOWN");
    expect(mcfEmploymentTypeRaw(null)).toBe("UNKNOWN");
    expect(mcfCompensationText({ min: 80000, max: 80000, currency: "SGD", period: "Annually" })).toBe("SGD 80,000 per year");
    expect(mcfCompensationText({ min: 5000, max: null, currency: "SGD", period: "Monthly" })).toBeNull();
    expect(mcfCompensationText(null)).toBeNull();
    expect(isMcfPlaceholderCompany("Unknown Company")).toBe(true);
    expect(isMcfPlaceholderCompany("Example Synthetic Analytics")).toBe(false);
    expect(isMcfPlaceholderDescription("N/A")).toBe(true);
    expect(isMcfPlaceholderDescription(DESCRIPTION)).toBe(false);
  });

  it("derives a receipt-free posting observation from a stored export", () => {
    const derived = mcfSavedPostingDerivedObservation("00000000-0000-4000-8000-000000000001", {
      observationId: "00000000-0000-4000-8000-000000000002",
      mcfJobUuid: UUID_A,
      canonicalUrl: jobUrl(UUID_A),
      title: "Synthetic Data Engineer",
      companyName: "Example Synthetic Analytics",
      description: DESCRIPTION,
      location: null,
      compensation: "SGD 6,500 - 9,000 per month",
      employmentType: "Permanent",
      postedAt: "2026-11-01",
      expiresAt: "2026-12-01",
      importedAt: "2026-11-02T00:00:00.000Z",
      exportPayloadHash: "a".repeat(64),
    });
    expect(derived).toMatchObject({
      sourceName: "MCF_SAVED",
      sourcePluginKey: "mcf_saved",
      sourceExternalId: `mcf-job:${UUID_A}`,
      sourceUrl: jobUrl(UUID_A),
      derivedFromObservationId: "00000000-0000-4000-8000-000000000001",
      employmentTypeRaw: "PERMANENT",
      compensationRaw: "SGD 6,500 - 9,000 per month",
      workplaceTypeRaw: "UNKNOWN",
    });
    // The stored export hid the address; MCF lists only jobs in Singapore.
    expect(derived.locationRaw).toBe("Singapore");
    expect(derived.rawPayload).toMatchObject({
      source_content_status: "COMPLETE",
      content_provenance: "MCF_SAVED_EXPORT",
      saved_export_observation_id: "00000000-0000-4000-8000-000000000002",
      content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(derived.rawPayload).not.toHaveProperty("source_evidence");
  });

  it("fails the command when any item is invalid or failed, and parses the command line", () => {
    const report = (invalid: number, failed: number, normalizeSeedError: string | null = null) => ({
      totals: { invalid, failed },
      normalizeSeedError,
    }) as unknown as McfSavedImportReport;
    expect(mcfSavedImportExitCode(report(0, 0))).toBe(0);
    expect(mcfSavedImportExitCode(report(2, 0))).toBe(1);
    expect(mcfSavedImportExitCode(report(0, 1))).toBe(1);
    expect(mcfSavedImportExitCode(report(0, 0, "seed failed"))).toBe(1);
    expect(parseImportMcfSavedArguments(["export.json", "--dry-run"])).toEqual({ filePath: "export.json", dryRun: true });
    expect(() => parseImportMcfSavedArguments([])).toThrow(/Usage: npm run import:mcf-saved/);
    expect(() => parseImportMcfSavedArguments(["a.json", "--apply"])).toThrow(/Unsupported/);
  });
});

describe("MCF saved-jobs source registration", () => {
  it("registers MCF_SAVED as a manual, user-supplied, unscheduled source with an honest compliance note", () => {
    expect(SourceNameSchema.parse("MCF_SAVED")).toBe("MCF_SAVED");
    const manifest = SourcePluginSchema.parse(loadYaml(fs.readFileSync(
      path.resolve(process.cwd(), "config", "source-plugins", "mcf_saved.yml"),
      "utf8",
    )));
    expect(manifest).toMatchObject({
      source_key: "mcf_saved",
      kind: "manual_import",
      schedule: { enabled: false },
      compliance: {
        access_basis: "user_supplied",
        authenticated_scraping: false,
        terms_url: "https://www.mycareersfuture.gov.sg/terms-of-use",
      },
    });
    expect(manifest.availability?.full_posting_hosts ?? []).toEqual([]);
    expect(String(manifest.compliance.attribution_text)).toMatch(/USER-ACCEPTED RISK, PENDING SWDA PERMISSION/);
    expect(String(manifest.compliance.attribution_text)).toMatch(/not cleanly\s+compliant/);
  });
});

// --- Browser snippet, run against a minimal fake of the MCF Saved jobs page ---

interface FakeCard { readonly uuid: string; readonly title: string; readonly category: string | null }

interface SnippetRun {
  readonly fetches: Array<{ url: string; init: Record<string, unknown> }>;
  readonly downloads: unknown[];
  readonly logs: string[];
  /** The snippet's window, for calling jdeMcfExport.refresh() after the first run. */
  window?: Record<string, unknown>;
}

const SNIPPET_PATH = path.resolve(process.cwd(), "scripts", "mcf", "export_saved_jobs.console.js");

function apiDetail(uuid: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid,
    title: `Synthetic Role ${uuid.slice(0, 4)}`,
    description: `<p>About the role</p><ul><li>${DESCRIPTION.split("\n").join("</li><li>")}</li></ul>`,
    postedCompany: { name: "EXAMPLE SYNTHETIC POSTER PTE. LTD.", uen: "000000000X" },
    hiringCompany: null,
    address: { isOverseas: false, block: "1", street: "EXAMPLE STREET", building: "", postalCode: "000001" },
    employmentTypes: [{ id: 1, employmentType: "Permanent" }],
    salary: { minimum: 6500, maximum: 9000, type: { id: 4, salaryType: "Monthly" } },
    status: { id: 102, jobStatus: "Open" },
    metadata: {
      jobPostId: "MCF-2026-0000001",
      emailRecipient: "recruiter@example.invalid",
      totalNumberOfView: 3,
      newPostingDate: "2026-11-01",
      originalPostingDate: "2026-10-01",
      expiryDate: "2026-12-01",
      isHideSalary: false,
      isHideEmployerName: false,
      isHideHiringEmployerName: false,
      isHideCompanyAddress: false,
    },
    ...overrides,
  };
}

async function runSnippet(
  pages: FakeCard[][],
  respond: (uuid: string, call: number) => { status: number; body?: unknown; contentType?: string },
): Promise<SnippetRun> {
  const run: SnippetRun = { fetches: [], downloads: [], logs: [] };
  let pageIndex = 0;
  let search = "";
  const storage = new Map<string, string>();
  const link = (card: FakeCard) => ({
    getAttribute: (name: string) => (name === "href"
      ? `/job/${card.category ? `${card.category}/` : ""}synthetic-role-example-${card.uuid}?source=MCF`
      : null),
    querySelector: () => ({ textContent: `  ${card.title} ` }),
  });
  const next = {
    disabled: false,
    getAttribute: () => null,
    click: () => {
      // React re-renders asynchronously: the list first shows the old page.
      setTimeout(() => {
        pageIndex += 1;
        search = `?page=${pageIndex}`;
      }, 5);
    },
  };
  const list = {
    querySelectorAll: () => (pages[pageIndex] ?? []).flatMap((card) => [link(card), link(card)]),
  };
  const document = {
    querySelector: (selector: string) => {
      if (selector.includes("saved-jobs-page__header")) return {};
      if (selector.includes("card-list")) return list;
      if (selector.includes("card-loader-container")) return null;
      if (selector.includes("bookmarked-job-not-found")) return pages.length === 0 ? {} : null;
      if (selector.includes("pagination")) {
        return { querySelector: () => (pageIndex < pages.length - 1 ? next : null) };
      }
      return null;
    },
    querySelectorAll: () => [],
    createElement: () => ({ click: () => undefined, remove: () => undefined, set href(_v: string) {}, get href() { return "blob:fake"; } }),
    body: { appendChild: () => undefined },
  };
  class FakeBlob {
    constructor(parts: string[]) {
      run.downloads.push(JSON.parse(parts.join("")));
    }
  }
  class FakeURL extends URL {
    static createObjectURL(): string { return "blob:fake"; }
    static revokeObjectURL(): void {}
  }
  class FakeDOMParser {
    parseFromString(html: string) {
      // Repeat until stable so nested or split tags cannot survive a single pass.
      let text = html.replace(/<\/(p|li)>/g, "\n");
      let previous: string;
      do {
        previous = text;
        text = text.replace(/<[^>]*>/g, "");
      } while (text !== previous);
      return { querySelectorAll: () => ({ forEach: () => undefined }), body: { textContent: text } };
    }
  }
  const calls = new Map<string, number>();
  const context = vm.createContext({
    console: {
      log: (...args: unknown[]) => run.logs.push(args.join(" ")),
      warn: (...args: unknown[]) => run.logs.push(args.join(" ")),
      error: (...args: unknown[]) => run.logs.push(args.join(" ")),
    },
    location: {
      hostname: "www.mycareersfuture.gov.sg",
      origin: "https://www.mycareersfuture.gov.sg",
      pathname: "/saved-jobs",
      get search() { return search; },
      get href() { return `https://www.mycareersfuture.gov.sg/saved-jobs${search}`; },
    },
    document,
    window: {} as Record<string, unknown>,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
    // Delays collapse to a macrotask so the 2 s pacing does not slow the test.
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, 5)),
    fetch: async (url: string, init: Record<string, unknown>) => {
      run.fetches.push({ url, init });
      const uuid = url.split("/").pop() ?? "";
      const call = (calls.get(uuid) ?? 0) + 1;
      calls.set(uuid, call);
      const response = respond(uuid, call);
      return {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        headers: { get: () => response.contentType ?? "application/json; charset=utf-8" },
        json: async () => response.body,
      };
    },
    URL: FakeURL,
    URLSearchParams,
    Blob: FakeBlob,
    DOMParser: FakeDOMParser,
  });
  (context as Record<string, unknown>).window = context;
  await vm.runInContext(fs.readFileSync(SNIPPET_PATH, "utf8"), context);
  run.window = context as Record<string, unknown>;
  return run;
}

describe("MCF saved-jobs browser snippet", () => {
  const cardA: FakeCard = { uuid: UUID_A, title: "Synthetic Role 0123", category: "information-technology" };
  const cardB: FakeCard = { uuid: UUID_B, title: "Synthetic Role fedc", category: null };
  const cardC: FakeCard = { uuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", title: "Synthetic Role aaaa", category: "banking-finance" };

  it("walks every page, fetches details sequentially without credentials and emits only schema fields", async () => {
    const run = await runSnippet([[cardA, cardB], [cardC]], (uuid) => ({
      status: 200,
      body: apiDetail(uuid, uuid === UUID_B
        ? {
          hiringCompany: { name: "EXAMPLE SYNTHETIC EMPLOYER PTE. LTD." },
          salary: { minimum: 1, maximum: 2, type: { salaryType: "Monthly" } },
          metadata: { ...apiDetail(uuid).metadata as object, isHideSalary: true, isHideCompanyAddress: true },
        }
        : {}),
    }));

    expect(run.fetches.map((call) => call.url)).toEqual([
      `https://api.mycareersfuture.gov.sg/v2/jobs/${UUID_A}`,
      `https://api.mycareersfuture.gov.sg/v2/jobs/${UUID_B}`,
      "https://api.mycareersfuture.gov.sg/v2/jobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
    for (const call of run.fetches) {
      expect(call.init).toMatchObject({ method: "GET", credentials: "omit", headers: { "mcf-client": "jobseeker" } });
    }
    expect(run.downloads).toHaveLength(1);
    const exported = run.downloads[0] as Array<Record<string, unknown>>;
    expect(exported).toHaveLength(3);
    const text = JSON.stringify(exported);
    expect(text).not.toMatch(/recruiter@example\.invalid|emailRecipient|totalNumberOfView|"uen"|jobPostId/);
    for (const entry of exported) {
      expect(Object.keys(entry).sort()).toEqual(Object.keys(McfSavedJobItemSchema.shape).sort());
    }
    expect(exported[0]).toMatchObject({
      title: "Synthetic Role 0123",
      company: "EXAMPLE SYNTHETIC POSTER PTE. LTD.",
      url: jobUrl(UUID_A).replace("synthetic-data-engineer-example-synthetic-analytics", "synthetic-role-example"),
      descriptionStatus: "OK",
      location: "1 EXAMPLE STREET, Singapore 000001",
      salary: { min: 6500, max: 9000, currency: "SGD", period: "Monthly" },
      employmentType: "Permanent",
      postedAt: "2026-11-01",
      expiresAt: "2026-12-01",
      mcfJobUuid: UUID_A,
      sourcePage: "https://www.mycareersfuture.gov.sg/saved-jobs",
    });
    // Posting facts: MCF's original posting date, its job status and when the details were read.
    expect(exported[0]).toMatchObject({
      originalPostedAt: "2026-10-01",
      availabilityStatus: "OPEN",
      availabilityEvidence: "MyCareersFuture job status: Open",
    });
    expect(String(exported[0]?.postingCheckedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parseMcfSavedExport(exported).valid[0]?.rawPayload).toMatchObject({
      posted_at: "2026-10-01T00:00:00.000Z",
      reposted_at: "2026-11-01T00:00:00.000Z",
      source_expires_at: "2026-12-01T00:00:00.000Z",
      status: "open",
    });
    // Hidden salary and address stay null; the hiring employer is shown for agency posts.
    expect(exported[1]).toMatchObject({ company: "EXAMPLE SYNTHETIC EMPLOYER PTE. LTD.", salary: null, location: null });
    expect(String(exported[0]?.description)).toContain("Requirements: experience with SQL");

    const parsed = parseMcfSavedExport(exported);
    expect(parsed.invalid).toEqual([]);
    expect(parsed.valid.map((job) => job.mcfJobUuid)).toEqual([UUID_A, UUID_B, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
    expect(run.logs.join("\n")).toMatch(/pagination implies 3-4; collected: 3 over 2 page\(s\)/);
  });

  it("refresh() keeps earlier details and their check time when a re-read returns HTTP 404", async () => {
    const run = await runSnippet([[cardA, cardB]], (uuid, call) => (call >= 2 && uuid === UUID_A ? { status: 404, body: { message: "Not found" } } : { status: 200, body: apiDetail(uuid) }));
    const first = run.downloads[0] as Array<Record<string, unknown>>;
    const refresh = (run.window?.jdeMcfExport as { refresh: () => Promise<void> }).refresh;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await refresh();
    expect(run.downloads).toHaveLength(2);
    const second = run.downloads[1] as Array<Record<string, unknown>>;
    expect(second[0]).toMatchObject({
      descriptionStatus: "OK",
      availabilityStatus: "OPEN",
      postedAt: first[0]?.postedAt,
      postingCheckedAt: first[0]?.postingCheckedAt,
      postingRecheckFailure: "HTTP 404",
    });
    // The other job was re-read successfully: a newer check time and no failure.
    expect(String(second[1]?.postingCheckedAt) >= String(first[1]?.postingCheckedAt)).toBe(true);
    expect(second[1]?.postingRecheckFailure).toBeNull();
    const parsed = parseMcfSavedExport(second);
    expect(parsed.invalid).toEqual([]);
    expect(parsed.valid[0]?.rawPayload).toMatchObject({ availability_checked_at: first[0]?.postingCheckedAt });
  });

  it("stops at HTTP 429 without fetching further jobs and leaves the rest unfetched", async () => {
    const run = await runSnippet([[cardA, cardB, cardC]], (uuid) => (uuid === UUID_B ? { status: 429 } : { status: 200, body: apiDetail(uuid) }));
    expect(run.fetches.map((call) => call.url.split("/").pop())).toEqual([UUID_A, UUID_B]);
    expect(run.logs.join("\n")).toMatch(/STOPPED: MyCareersFuture rate limited the request \(HTTP 429\)/);
    const exported = run.downloads[0] as Array<Record<string, unknown>>;
    expect(exported.map((entry) => entry.descriptionStatus)).toEqual(["OK", null, null]);
    const parsed = parseMcfSavedExport(exported);
    expect(parsed.valid).toHaveLength(1);
    expect(parsed.invalid.map((entry) => entry.reason)).toEqual([
      expect.stringMatching(/not fetched yet/),
      expect.stringMatching(/not fetched yet/),
    ]);
  });

  it("stops on a non-JSON error page and records a removed job as MISSING", async () => {
    const run = await runSnippet([[cardA, cardB, cardC]], (uuid) => {
      if (uuid === UUID_A) return { status: 404, body: { message: "Not found" } };
      if (uuid === UUID_B) return { status: 200, body: "<html>error</html>", contentType: "text/html" };
      return { status: 200, body: apiDetail(uuid) };
    });
    expect(run.fetches).toHaveLength(2);
    expect(run.logs.join("\n")).toMatch(/non-JSON \(error\) page/);
    const exported = run.downloads[0] as Array<Record<string, unknown>>;
    expect(exported.map((entry) => entry.descriptionStatus)).toEqual(["MISSING", null, null]);
    expect(exported[0]?.title).toBe("Synthetic Role 0123");
  });
});
