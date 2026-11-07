import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import * as yaml from "js-yaml";
import { WorkableAdapter } from "../../ingestion/adapters/workableAdapter.js";
import { SmartRecruitersAdapter, SMARTRECRUITERS_MAX_PAGE_SIZE } from "../../ingestion/adapters/smartRecruitersAdapter.js";
import { SourceNameSchema, SourcePluginSchema } from "../../contracts/index.js";
import { loadKnownEmployerBoards } from "../../ingestion/employerBoardLookup.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Synthetic fixtures only: no real employer or posting text.
function workableJob(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const shortcode = `SYN${String(index).padStart(4, "0")}`;
  return {
    title: `Synthetic Platform Architect ${index}`,
    shortcode,
    employment_type: "Full-time",
    telecommuting: false,
    url: `https://apply.workable.com/j/${shortcode}`,
    application_url: `https://apply.workable.com/j/${shortcode}/apply`,
    published_on: "2026-10-01",
    country: "Singapore",
    city: "Singapore",
    state: "",
    locations: [{ country: "Singapore", countryCode: "SG", city: "Singapore", region: "", hidden: false }],
    description: "<p>Design <strong>data platform</strong> services.</p><script>alert(1)</script><ul><li>Lead architecture reviews</li></ul>",
    ...overrides,
  };
}

describe("WorkableAdapter", () => {
  it("maps a widget posting, converts description HTML to text and keeps the raw payload", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      name: "Example Analytics",
      description: "Synthetic account",
      jobs: [workableJob(1, {
        telecommuting: true,
        locations: [
          { country: "Germany", countryCode: "DE", city: "Berlin", region: "Berlin", hidden: false },
          { country: "Hidden Land", city: "Nowhere", hidden: true },
        ],
      })],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new WorkableAdapter("example-analytics").fetchJobs({ limit: 10 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      "https://apply.workable.com/api/v1/widget/accounts/example-analytics?details=true",
    );
    expect(result).toMatchObject({ sourceName: "WORKABLE", success: true, totalFetched: 1, snapshotTotal: 1, quarantined: 0 });
    const job = result.jobs[0];
    expect(job).toMatchObject({
      source_external_id: "SYN0001",
      company_name: "Example Analytics",
      title: "Synthetic Platform Architect 1",
      location_raw: "Berlin, Berlin, Germany",
      workplace_type_raw: "REMOTE",
      employment_type_raw: "Full-time",
      employer_posting_url: "https://apply.workable.com/j/SYN0001",
      application_url: "https://apply.workable.com/j/SYN0001/apply",
      canonical_apply_url: "https://apply.workable.com/j/SYN0001/apply",
      published_at: "2026-10-01T00:00:00.000Z",
    });
    expect(job.description_raw).toBe("Design data platform services. Lead architecture reviews");
    expect(job.description_raw).not.toContain("alert");
    expect(job.raw_payload).toMatchObject({ shortcode: "SYN0001" });
  });

  it("does not invent an on-site work mode when the remote flag is false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ name: "Example", jobs: [workableJob(1)] })));
    const result = await new WorkableAdapter("example").fetchJobs();
    expect(result.jobs[0].workplace_type_raw).toBe("UNKNOWN");
    expect(result.jobs[0].location_raw).toBe("Singapore, Singapore");
  });

  it("pages a full board snapshot with a stable cursor and no duplicates", async () => {
    const jobs = Array.from({ length: 45 }, (_, index) => workableJob(index + 1));
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ name: "Example", jobs: [...jobs].reverse() })));
    const adapter = new WorkableAdapter("example");
    const seen: string[] = [];
    let cursor: string | null = null;
    let calls = 0;
    do {
      const result = await adapter.fetchJobs({ limit: 20, cursor });
      expect(result.success).toBe(true);
      seen.push(...result.jobs.map((job) => job.source_external_id ?? ""));
      cursor = result.nextCursor ?? null;
      calls++;
    } while (cursor !== null && calls < 5);
    expect(calls).toBe(3);
    expect(new Set(seen).size).toBe(45);
  });

  it("reports an unknown account (404) as a source failure, not an empty success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not Found", { status: 404, statusText: "Not Found" })));
    const result = await new WorkableAdapter("no-such-account").fetchJobs();
    expect(result.success).toBe(false);
    expect(result.jobs).toEqual([]);
    expect(result.error).toContain("Workable account not found");
  });

  it("fails on rate limits, server errors, malformed payloads and timeouts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    expect(await new WorkableAdapter("example").fetchJobs()).toMatchObject({ success: false, isRateLimited: true });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503, statusText: "Service Unavailable" })));
    expect(await new WorkableAdapter("example").fetchJobs()).toMatchObject({ success: false, error: "HTTP 503: Service Unavailable" });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ name: "Example" })));
    expect(await new WorkableAdapter("example").fetchJobs()).toMatchObject({
      success: false,
      error: "Workable response is missing its jobs array.",
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{not json", { status: 200 })));
    expect((await new WorkableAdapter("example").fetchJobs()).success).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }));
    expect(await new WorkableAdapter("example").fetchJobs()).toMatchObject({ success: false, error: "Timeout after 15000ms" });
  });

  it("quarantines postings missing identity or description with their raw payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      name: "Example",
      jobs: [workableJob(1), workableJob(2, { description: "<p> </p>" }), workableJob(3, { shortcode: "" })],
    })));
    const result = await new WorkableAdapter("example").fetchJobs();
    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.source_external_id)).toEqual(["SYN0001"]);
    expect(result.quarantined).toBe(2);
    expect(result.quarantinedCandidates).toHaveLength(2);
    expect(result.quarantinedCandidates?.map((candidate) => candidate.error)).toEqual(expect.arrayContaining([
      "Workable posting is missing description.",
      "Workable posting is missing shortcode.",
    ]));
  });

  it("fails the run when every posting is quarantined", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ name: "Example", jobs: [workableJob(1, { title: "" })] })));
    const result = await new WorkableAdapter("example").fetchJobs();
    expect(result).toMatchObject({ success: false, quarantined: 1 });
  });

  it("returns a successful empty result for an existing account with no postings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ name: "Example", jobs: [] })));
    expect(await new WorkableAdapter("example").fetchJobs()).toMatchObject({ success: true, jobs: [], totalFetched: 0 });
  });

  it("rejects account slugs that could alter the request path", () => {
    expect(() => new WorkableAdapter("../admin")).toThrow("Invalid Workable account slug");
  });
});

function srListing(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Synthetic Data Architect ${id}`,
    company: { identifier: "ExampleCo", name: "Example Company" },
    releasedDate: "2026-10-02T03:04:05.000Z",
    location: { city: "Singapore", country: "sg", remote: false, hybrid: false, fullLocation: "Singapore, , Singapore" },
    typeOfEmployment: { id: "permanent", label: "Full-time" },
    ...overrides,
  };
}

function srDetail(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...srListing(id),
    postingUrl: `https://jobs.smartrecruiters.com/ExampleCo/${id}-synthetic-data-architect`,
    applyUrl: `https://jobs.smartrecruiters.com/ExampleCo/${id}-synthetic-data-architect?oga=true`,
    jobAd: {
      sections: {
        companyDescription: { title: "Company Description", text: "<p>Synthetic company.</p>" },
        jobDescription: { title: "Job Description", text: "<ul><li>Design data platform architecture</li></ul>" },
        qualifications: { title: "Qualifications", text: "<p>Platform <em>engineering</em> experience.</p>" },
        additionalInformation: { title: "Additional Information", text: "" },
      },
    },
    ...overrides,
  };
}

interface SrBoard {
  readonly totalFound: number;
  readonly listings: readonly Record<string, unknown>[];
  readonly details?: Readonly<Record<string, Response | Record<string, unknown>>>;
}

function stubSmartRecruiters(board: SrBoard): string[] {
  const requested: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    requested.push(input);
    const url = new URL(input);
    const detailMatch = url.pathname.match(/\/postings\/([^/]+)$/);
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]);
      const override = board.details?.[id];
      if (override instanceof Response) return override;
      return jsonResponse(override ?? srDetail(id));
    }
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    return jsonResponse({ offset, limit, totalFound: board.totalFound, content: board.listings.slice(offset, offset + limit) });
  }));
  return requested;
}

describe("SmartRecruitersAdapter", () => {
  const ids = Array.from({ length: 5 }, (_, index) => `74400000000${index + 1}`);

  it("maps a listed posting with its detail sections as description text", async () => {
    const requested = stubSmartRecruiters({ totalFound: 1, listings: [srListing(ids[0])] });

    const result = await new SmartRecruitersAdapter("ExampleCo", { detailDelayMs: 0 }).fetchJobs({ limit: 10 });

    expect(requested).toEqual([
      "https://api.smartrecruiters.com/v1/companies/ExampleCo/postings?limit=10&offset=0",
      `https://api.smartrecruiters.com/v1/companies/ExampleCo/postings/${ids[0]}`,
    ]);
    expect(result).toMatchObject({ sourceName: "SMARTRECRUITERS", success: true, totalFetched: 1, snapshotTotal: 1, nextCursor: null });
    expect(result.jobs[0]).toMatchObject({
      source_external_id: ids[0],
      company_name: "Example Company",
      title: `Synthetic Data Architect ${ids[0]}`,
      location_raw: "Singapore, Singapore",
      workplace_type_raw: "UNKNOWN",
      employment_type_raw: "Full-time",
      employer_posting_url: `https://jobs.smartrecruiters.com/ExampleCo/${ids[0]}-synthetic-data-architect`,
      application_url: `https://jobs.smartrecruiters.com/ExampleCo/${ids[0]}-synthetic-data-architect?oga=true`,
      published_at: "2026-10-02T03:04:05.000Z",
    });
    expect(result.jobs[0].description_raw).toBe([
      "Company Description: Synthetic company.",
      "Job Description: Design data platform architecture",
      "Qualifications: Platform engineering experience.",
    ].join("\n\n"));
    expect(result.jobs[0].raw_payload).toMatchObject({ id: ids[0], jobAd: expect.any(Object) });
  });

  it("uses explicit remote and hybrid flags only", async () => {
    stubSmartRecruiters({
      totalFound: 2,
      listings: [srListing(ids[0]), srListing(ids[1])],
      details: {
        [ids[0]]: srDetail(ids[0], { location: { city: "Remote", country: "sg", remote: true, hybrid: false } }),
        [ids[1]]: srDetail(ids[1], { location: { city: "Singapore", country: "sg", remote: false, hybrid: true } }),
      },
    });
    const result = await new SmartRecruitersAdapter("ExampleCo", { detailDelayMs: 0 }).fetchJobs();
    expect(result.jobs.map((job) => job.workplace_type_raw)).toEqual(["REMOTE", "HYBRID"]);
  });

  it("pages by offset, bounds detail calls to the page size and completes the cycle", async () => {
    const requested = stubSmartRecruiters({ totalFound: 5, listings: ids.map((id) => srListing(id)) });
    const adapter = new SmartRecruitersAdapter("ExampleCo", { detailDelayMs: 0 });

    const first = await adapter.fetchJobs({ limit: 2 });
    expect(first).toMatchObject({ success: true, totalFetched: 2, nextCursor: "offset:2", hasMore: true });
    expect(requested).toHaveLength(3);
    const second = await adapter.fetchJobs({ limit: 2, cursor: first.nextCursor });
    const third = await adapter.fetchJobs({ limit: 2, cursor: second.nextCursor });
    expect(third).toMatchObject({ success: true, totalFetched: 1, nextCursor: null, hasMore: false });
    expect([...first.jobs, ...second.jobs, ...third.jobs].map((job) => job.source_external_id)).toEqual(ids);
    expect(requested.filter((url) => url.includes("?limit="))).toEqual([
      "https://api.smartrecruiters.com/v1/companies/ExampleCo/postings?limit=2&offset=0",
      "https://api.smartrecruiters.com/v1/companies/ExampleCo/postings?limit=2&offset=2",
      "https://api.smartrecruiters.com/v1/companies/ExampleCo/postings?limit=2&offset=4",
    ]);
  });

  it("caps the list page at the API maximum", async () => {
    const requested = stubSmartRecruiters({ totalFound: 1, listings: [srListing(ids[0])] });
    await new SmartRecruitersAdapter("ExampleCo", { detailDelayMs: 0 }).fetchJobs({ limit: 500 });
    expect(requested[0]).toContain(`limit=${SMARTRECRUITERS_MAX_PAGE_SIZE}&`);
  });

  it("treats an unknown company (200 with totalFound 0) as board not found", async () => {
    const requested = stubSmartRecruiters({ totalFound: 0, listings: [] });
    const result = await new SmartRecruitersAdapter("examplecompany", { detailDelayMs: 0 }).fetchJobs();
    expect(result.success).toBe(false);
    expect(result.jobs).toEqual([]);
    expect(result.error).toContain("SmartRecruiters company not found");
    expect(requested).toHaveLength(1);
  });

  it("fails the whole page when a detail request fails, so the checkpoint does not advance", async () => {
    stubSmartRecruiters({
      totalFound: 2,
      listings: [srListing(ids[0]), srListing(ids[1])],
      details: { [ids[1]]: new Response("", { status: 500, statusText: "Internal Server Error" }) },
    });
    const result = await new SmartRecruitersAdapter("ExampleCo", { detailDelayMs: 0 }).fetchJobs();
    expect(result).toMatchObject({ success: false, jobs: [] });
    expect(result.error).toBe(`HTTP 500: Internal Server Error (posting ${ids[1]} detail)`);
  });

  it("reports a detail rate limit as a rate-limited source failure", async () => {
    stubSmartRecruiters({
      totalFound: 1,
      listings: [srListing(ids[0])],
      details: { [ids[0]]: new Response("", { status: 429 }) },
    });
    const result = await new SmartRecruitersAdapter("ExampleCo", { detailDelayMs: 0 }).fetchJobs();
    expect(result).toMatchObject({ success: false, isRateLimited: true });
  });

  it("rejects a detail that belongs to a different posting", async () => {
    stubSmartRecruiters({
      totalFound: 1,
      listings: [srListing(ids[0])],
      details: { [ids[0]]: srDetail(ids[1]) },
    });
    const result = await new SmartRecruitersAdapter("ExampleCo", { detailDelayMs: 0 }).fetchJobs();
    expect(result.success).toBe(false);
    expect(result.error).toContain("different or missing posting id");
  });

  it("fails on list errors, malformed list payloads and timeouts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    expect(await new SmartRecruitersAdapter("ExampleCo").fetchJobs()).toMatchObject({ success: false, isRateLimited: true });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ content: [] })));
    expect(await new SmartRecruitersAdapter("ExampleCo").fetchJobs()).toMatchObject({
      success: false,
      error: "SmartRecruiters posting list is missing totalFound or content.",
    });

    vi.stubGlobal("fetch", vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }));
    expect(await new SmartRecruitersAdapter("ExampleCo").fetchJobs()).toMatchObject({ success: false, error: "Timeout after 15000ms" });
  });

  it("quarantines postings with no job-ad text and keeps the rest", async () => {
    stubSmartRecruiters({
      totalFound: 2,
      listings: [srListing(ids[0]), srListing(ids[1])],
      details: { [ids[1]]: srDetail(ids[1], { jobAd: { sections: {} } }) },
    });
    const result = await new SmartRecruitersAdapter("ExampleCo", { detailDelayMs: 0 }).fetchJobs();
    expect(result).toMatchObject({ success: true, quarantined: 1 });
    expect(result.jobs.map((job) => job.source_external_id)).toEqual([ids[0]]);
    expect(result.quarantinedCandidates).toEqual([
      expect.objectContaining({ identity: ids[1], error: "SmartRecruiters posting is missing job ad sections." }),
    ]);
  });

  it("returns a successful empty page past the end of an existing board", async () => {
    stubSmartRecruiters({ totalFound: 2, listings: [srListing(ids[0]), srListing(ids[1])] });
    const result = await new SmartRecruitersAdapter("ExampleCo", { detailDelayMs: 0 }).fetchJobs({ cursor: "offset:2" });
    expect(result).toMatchObject({ success: true, jobs: [], totalFetched: 0, nextCursor: null });
  });

  it("rejects company identifiers that could alter the request path", () => {
    expect(() => new SmartRecruitersAdapter("Example/../x")).toThrow("Invalid SmartRecruiters company identifier");
  });
});

describe("Workable and SmartRecruiters registration", () => {
  const pluginsDir = path.join(process.cwd(), "config", "source-plugins");

  it("registers canonical source names and valid plugin manifests", () => {
    expect(SourceNameSchema.parse("WORKABLE")).toBe("WORKABLE");
    expect(SourceNameSchema.parse("SMARTRECRUITERS")).toBe("SMARTRECRUITERS");
    for (const [file, key] of [["workable.yml", "workable"], ["smartrecruiters.yml", "smartrecruiters"]] as const) {
      const manifest = SourcePluginSchema.parse(yaml.load(fs.readFileSync(path.join(pluginsDir, file), "utf-8")));
      expect(manifest).toMatchObject({ source_key: key, kind: "ats", status: "active" });
      expect(manifest.compliance.authenticated_scraping).toBe(false);
    }
    const smartRecruiters = SourcePluginSchema.parse(yaml.load(fs.readFileSync(path.join(pluginsDir, "smartrecruiters.yml"), "utf-8")));
    expect(smartRecruiters.request.rate_limit.items_per_run).toBeLessThanOrEqual(SMARTRECRUITERS_MAX_PAGE_SIZE);
  });

  it("adds both sources to the four ATS-backed lanes of the source plan", () => {
    const plan = yaml.load(fs.readFileSync(path.join(process.cwd(), "config", "source-plans", "six_lane_sources.yml"), "utf-8")) as {
      lanes: Record<string, { source_keys: string[] }>;
    };
    for (const lane of ["CORE_AI_DATA", "LEGAL_REGTECH", "HEALTH_BIO_PHARMA", "INVESTMENT_MARKETS_FINTECH"]) {
      expect(plan.lanes[lane].source_keys).toEqual(expect.arrayContaining(["workable", "smartrecruiters"]));
    }
  });

  it("keeps the company registry free of duplicate ids and boards, and loadable for board lookup", () => {
    const companies = (yaml.load(fs.readFileSync(path.join(process.cwd(), "config", "companies.yml"), "utf-8")) as {
      companies: Array<{ id: string; ats_provider: string; board_slug: string | null; enabled: boolean }>;
    }).companies;
    const ids = companies.map((company) => company.id);
    expect(new Set(ids).size).toBe(ids.length);
    const boards = companies.filter((company) => company.board_slug).map((company) => `${company.ats_provider}:${String(company.board_slug).toLowerCase()}`);
    expect(new Set(boards).size).toBe(boards.length);
    expect(companies.find((company) => company.id === "openai")).toMatchObject({ ats_provider: "ashby", board_slug: "openai", enabled: false });
    expect(companies.find((company) => company.id === "wise")).toMatchObject({ ats_provider: "smartrecruiters", board_slug: "Wise" });
    expect(companies.some((company) => company.ats_provider === "greenhouse" && company.board_slug === "wise")).toBe(false);
    expect(loadKnownEmployerBoards().find((board) => board.boardToken === "mistral.ai")).toMatchObject({ provider: "ASHBY" });
  });
});
