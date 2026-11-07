import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourcePluginSchema } from "../../contracts/index.js";
import {
  WORKDAY_MAX_PAGE_SIZE,
  WorkdayAdapter,
  selectSingaporeFacet,
  workdayDeadlineBudget,
  workdayHtmlToText,
  workdaySearchTerms,
  type WorkdayRunLimits,
} from "../../ingestion/adapters/workdayAdapter.js";
import { loadSixLaneSourcePlanConfig } from "../../ingestion/discoveryPlanConfig.js";
import {
  CompanyConfigSchema,
  loadCompaniesConfig,
  rotateDaily,
  workdaySearchTermsForLanes,
} from "../../../scripts/run_adapters.js";
import { DiscoveryScoutPlanner } from "../../ingestion/scouts/discoveryScouts.js";

// Synthetic tenant and postings only.
const HOST = "examplecorp.wd5.myworkdayjobs.com";
const TENANT = "examplecorp";
const SITE = "Example_Careers";
const API = `https://${HOST}/wday/cxs/${TENANT}/${SITE}`;
const SG_COUNTRY_ID = "sg-country-0001";

const SG_FACETS = [
  { facetParameter: "jobFamilyGroup", values: [{ descriptor: "Technology", id: "fam-1", count: 9 }] },
  {
    facetParameter: "locationMainGroup",
    values: [
      { facetParameter: "locationCountry", values: [
        { descriptor: "Singapore", id: SG_COUNTRY_ID, count: 12 },
        { descriptor: "Malaysia", id: "my-country-0001", count: 4 },
      ] },
      { facetParameter: "locations", values: [
        { descriptor: "Singapore - Example Tower", id: "sg-site-0001", count: 12 },
      ] },
    ],
  },
];

interface Call { method: string; url: string; body: Record<string, unknown> | null }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function hit(slug: string, locationsText = "Singapore - Example Tower") {
  return { title: `Role ${slug}`, externalPath: `/job/Singapore/${slug}`, locationsText, postedOn: "Posted Today", bulletFields: [`REQ-${slug}`] };
}

function detail(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    jobPostingInfo: {
      id: `posting-${slug}`,
      title: `Synthetic Data Architect ${slug}`,
      jobDescription: `<p><b>About the role</b></p><ul><li>Design synthetic data platforms &amp; pipelines.</li><li>Lead architecture reviews.</li></ul><script>ignored()</script>`,
      location: "Singapore - Example Tower",
      timeType: "Full time",
      startDate: "2026-10-30",
      remoteType: "Hybrid",
      jobReqId: `REQ-${slug}`,
      externalUrl: `https://${HOST}/${SITE}/job/Singapore/${slug}`,
      ...overrides,
    },
    hiringOrganization: { name: "Example Corp Pte. Ltd." },
  };
}

/**
 * A fake Workday tenant: facet discovery, searches by term (each term maps to a list of hits)
 * and details by externalPath. `override` lets a test replace the response for a given call.
 */
function fakeTenant(input: {
  readonly facets?: unknown;
  readonly hitsByTerm?: Record<string, ReturnType<typeof hit>[]>;
  readonly details?: Record<string, unknown>;
  readonly override?: (call: Call, index: number) => Response | undefined;
}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    const call: Call = { method: init?.method ?? "GET", url: String(url), body };
    calls.push(call);
    const overridden = input.override?.(call, calls.length - 1);
    if (overridden) return overridden;
    if (call.method === "POST" && call.url === `${API}/jobs`) {
      const searchText = String(body?.searchText ?? "");
      const limit = Number(body?.limit);
      const offset = Number(body?.offset);
      if (limit > WORKDAY_MAX_PAGE_SIZE) return json({ total: 0, jobPostings: [] });
      if (searchText === "") return json({ total: 40, jobPostings: [hit("discovery")].slice(0, limit), facets: input.facets ?? SG_FACETS });
      const all = input.hitsByTerm?.[searchText] ?? [];
      // Workday reports `total` only on the first page.
      return json({ total: offset === 0 ? all.length : 0, jobPostings: all.slice(offset, offset + limit) });
    }
    if (call.method === "GET" && call.url.startsWith(`${API}/job/`)) {
      const externalPath = call.url.slice(API.length);
      const found = input.details?.[externalPath];
      return found ? json(found) : json({ errorCode: "S21" }, 404);
    }
    return json({ error: "unexpected" }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function adapter(terms: string[], limits: Partial<WorkdayRunLimits> = {}, budget = null as ReturnType<typeof workdayDeadlineBudget> | null) {
  return new WorkdayAdapter({
    config: { companyName: "Example Corp", host: HOST, tenant: TENANT, site: SITE },
    searchTerms: terms,
    limits: { requestDelayMs: 0, ...limits },
    budget,
    sleep: async () => undefined,
  });
}

function detailsFor(slugs: string[]): Record<string, unknown> {
  return Object.fromEntries(slugs.map((slug) => [`/job/Singapore/${slug}`, detail(slug)]));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Workday CXS adapter", () => {
  it("pages search results 20 at a time, applies the Singapore facet and maps details", async () => {
    const slugs = Array.from({ length: 25 }, (_, index) => `r${String(index).padStart(2, "0")}`);
    const { calls } = fakeTenant({ hitsByTerm: { "data architect": slugs.map((slug) => hit(slug)) }, details: detailsFor(slugs) });

    const result = await adapter(["Data Architect"], { searchTermsPerRun: 1, maxPagesPerTerm: 3 }).fetchJobs({ limit: 30 });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(25);
    const searches = calls.filter((call) => call.method === "POST");
    expect(searches.map((call) => [call.body?.searchText, call.body?.offset, call.body?.limit])).toEqual([
      ["", 0, 1],
      ["data architect", 0, 20],
      ["data architect", 20, 20],
    ]);
    for (const call of searches) {
      expect(Number(call.body?.limit)).toBeLessThanOrEqual(WORKDAY_MAX_PAGE_SIZE);
    }
    expect(searches[1].body?.appliedFacets).toEqual({ locationCountry: [SG_COUNTRY_ID] });
    expect(result.nextCursor).toBeNull();

    const job = result.jobs[0];
    expect(job).toMatchObject({
      source_external_id: `workday:${TENANT}:${SITE}/job/Singapore/r00`,
      company_name: "Example Corp",
      title: "Synthetic Data Architect r00",
      location_raw: "Singapore - Example Tower",
      workplace_type_raw: "HYBRID",
      employment_type_raw: "FULL_TIME",
      compensation_raw: "UNKNOWN",
      employer_posting_url: `https://${HOST}/${SITE}/job/Singapore/r00`,
      canonical_apply_url: `https://${HOST}/${SITE}/job/Singapore/r00`,
      published_at: "2026-10-30T00:00:00.000Z",
      description_raw: "About the role\nDesign synthetic data platforms & pipelines.\nLead architecture reviews.",
    });
    expect(job.raw_payload).toMatchObject({
      workday: { host: HOST, tenant: TENANT, site: SITE, external_path: "/job/Singapore/r00" },
      job_req_id: "REQ-r00",
      hiring_organization: "Example Corp Pte. Ltd.",
    });
  });

  it("never asks for more than 20 rows, and stops at the page bound with the term marked truncated", async () => {
    const slugs = Array.from({ length: 50 }, (_, index) => `t${String(index).padStart(2, "0")}`);
    const { calls } = fakeTenant({ hitsByTerm: { "ai engineer": slugs.map((slug) => hit(slug)) }, details: detailsFor(slugs) });
    const workday = adapter(["AI engineer"], { searchTermsPerRun: 1, maxPagesPerTerm: 2 });

    const result = await workday.fetchJobs({ limit: 100 });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(40);
    expect(calls.filter((call) => call.method === "POST").every((call) => Number(call.body?.limit) <= 20)).toBe(true);
    expect(workday.lastRunStats?.truncatedTerms).toEqual(["ai engineer"]);
  });

  it("bounds details per run and resumes from the cursor in relevance order", async () => {
    const slugs = ["zeta", "alpha", "mid"];
    fakeTenant({
      hitsByTerm: { "data engineer": slugs.map((slug) => hit(slug)), "solutions architect": [hit("alpha"), hit("omega")] },
      details: detailsFor([...slugs, "omega"]),
    });
    const terms = ["solutions architect", "data engineer"];

    const first = await adapter(terms, { searchTermsPerRun: 2 }).fetchJobs({ limit: 2 });
    expect(first.success).toBe(true);
    expect(first.jobs.map((job) => job.title)).toEqual(["Synthetic Data Architect zeta", "Synthetic Data Architect alpha"]);
    expect(first.nextCursor).toBe("wd:v1:0:2");

    const second = await adapter(terms, { searchTermsPerRun: 2 }).fetchJobs({ limit: 2, cursor: first.nextCursor });
    // "alpha" also matches the next term; it is fetched once per run.
    expect(second.jobs.map((job) => job.title)).toEqual(["Synthetic Data Architect mid", "Synthetic Data Architect alpha"]);
    expect(second.nextCursor).toBe("wd:v1:1:1");

    const third = await adapter(terms, { searchTermsPerRun: 2 }).fetchJobs({ limit: 2, cursor: second.nextCursor });
    expect(third.jobs.map((job) => job.title)).toEqual(["Synthetic Data Architect omega"]);
    expect(third.nextCursor).toBeNull();
  });

  it("restarts at the first term when the cursor is foreign or out of range", async () => {
    fakeTenant({ hitsByTerm: { "data engineer": [hit("a")] }, details: detailsFor(["a"]) });
    for (const cursor of ["after:something", "wd:v1:9:0", "wd:v1:x:y"]) {
      const result = await adapter(["data engineer"]).fetchJobs({ limit: 5, cursor });
      expect(result.jobs).toHaveLength(1);
    }
  });

  it("selects a country-level Singapore facet, else every Singapore value of the busiest location facet", () => {
    expect(selectSingaporeFacet(SG_FACETS)).toEqual({ parameter: "locationCountry", valueIds: [SG_COUNTRY_ID], descriptors: ["Singapore"] });
    expect(selectSingaporeFacet([{ facetParameter: "locationMainGroup", values: [{ facetParameter: "locations", values: [
      { descriptor: "Central Singapore", id: "loc-a", count: 5 },
      { descriptor: "Singapore", id: "loc-b", count: 2 },
      { descriptor: "Kuala Lumpur", id: "loc-c", count: 9 },
    ] }] }])).toEqual({ parameter: "locations", valueIds: ["loc-a", "loc-b"], descriptors: ["Central Singapore", "Singapore"] });
    expect(selectSingaporeFacet([{ facetParameter: "jobFamilyGroup", values: [{ descriptor: "Singapore Desk", id: "x", count: 1 }] }])).toBeNull();
    expect(selectSingaporeFacet(undefined)).toBeNull();
  });

  it("filters by location text when the tenant has no Singapore facet and confirms multi-location hits on the detail", async () => {
    const hits = [hit("sg"), hit("tokyo", "Tokyo, Japan"), hit("multi-sg", "2 Locations"), hit("multi-other", "3 Locations")];
    const details = {
      ...detailsFor(["sg"]),
      "/job/Singapore/multi-sg": detail("multi-sg", { location: "Tokyo, Japan", additionalLocations: ["Singapore - Example Tower"] }),
      "/job/Singapore/multi-other": detail("multi-other", { location: "Tokyo, Japan", additionalLocations: ["Seoul, Korea"] }),
    };
    const { calls } = fakeTenant({ facets: [], hitsByTerm: { "data engineer": hits }, details });
    const workday = adapter(["data engineer"]);

    const result = await workday.fetchJobs({ limit: 10 });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.location_raw)).toEqual([
      "Singapore - Example Tower",
      "Tokyo, Japan; Singapore - Example Tower",
    ]);
    expect(calls.find((call) => call.body?.searchText === "data engineer")?.body?.appliedFacets).toEqual({});
    expect(calls.some((call) => call.url.endsWith("/tokyo"))).toBe(false);
    expect(workday.lastRunStats).toMatchObject({ facet: null, notSingapore: 2 });
  });

  it.each([
    ["403", () => new Response("Access Denied", { status: 403, headers: { "Content-Type": "text/html" } })],
    ["429", () => json({ error: "Too many requests" }, 429)],
    ["bot page", () => new Response("<html><body>Please verify you are a human</body></html>", { status: 200, headers: { "Content-Type": "text/html" } })],
    ["redirect", () => new Response(null, { status: 302, headers: { Location: "https://challenge.example.test/" } })],
  ])("treats a %s search response as a retryable rate-limited failure, not an empty success", async (_label, response) => {
    fakeTenant({ override: (call) => (call.method === "POST" ? response() : undefined) });

    const result = await adapter(["data engineer"]).fetchJobs({ limit: 5, cursor: "wd:v1:0:0" });

    expect(result.success).toBe(false);
    expect(result.isRateLimited).toBe(true);
    expect(result.error).toContain(TENANT);
    expect(result.nextCursor).toBe("wd:v1:0:0");
  });

  it("keeps postings fetched before a mid-run block, but fails the run", async () => {
    fakeTenant({
      hitsByTerm: { "data engineer": [hit("a"), hit("b")] },
      details: detailsFor(["a", "b"]),
      override: (call) => (call.url.endsWith("/job/Singapore/b") ? json({}, 429) : undefined),
    });

    const result = await adapter(["data engineer"]).fetchJobs({ limit: 5 });

    expect(result.success).toBe(false);
    expect(result.isRateLimited).toBe(true);
    expect(result.jobs.map((job) => job.title)).toEqual(["Synthetic Data Architect a"]);
  });

  it("fails on malformed search JSON, server errors and timeouts without rate-limit flags", async () => {
    fakeTenant({ override: (call) => (call.method === "POST" ? json({ unexpected: true }) : undefined) });
    const malformed = await adapter(["data engineer"]).fetchJobs({ limit: 5 });
    expect(malformed).toMatchObject({ success: false, isRateLimited: false });
    expect(malformed.error).toContain("no jobPostings array");

    fakeTenant({ override: () => json({}, 503) });
    const unavailable = await adapter(["data engineer"]).fetchJobs({ limit: 5 });
    expect(unavailable).toMatchObject({ success: false, isRateLimited: false });

    vi.stubGlobal("fetch", vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }));
    const timedOut = await adapter(["data engineer"]).fetchJobs({ limit: 5 });
    expect(timedOut.success).toBe(false);
    expect(timedOut.error).toContain("timed out");
  });

  it("treats an empty tenant as a successful empty run that completes the cycle", async () => {
    fakeTenant({ facets: [], hitsByTerm: {} });

    const result = await adapter(["data engineer", "ai engineer"], { searchTermsPerRun: 5 }).fetchJobs({ limit: 5 });

    expect(result).toMatchObject({ success: true, jobs: [], totalFetched: 0, nextCursor: null });
  });

  it("counts a withdrawn posting (detail 404) as gone, not as a failure", async () => {
    const workday = adapter(["data engineer"]);
    fakeTenant({ hitsByTerm: { "data engineer": [hit("gone"), hit("live")] }, details: detailsFor(["live"]) });

    const result = await workday.fetchJobs({ limit: 5 });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(workday.lastRunStats?.detailsGone).toBe(1);
  });

  it("quarantines a detail whose externalUrl does not match the searched posting", async () => {
    fakeTenant({
      hitsByTerm: { "data engineer": [hit("a")] },
      details: { "/job/Singapore/a": detail("a", { externalUrl: `https://${HOST}/${SITE}/job/Singapore/other` }) },
    });

    const result = await adapter(["data engineer"]).fetchJobs({ limit: 5 });

    expect(result.jobs).toHaveLength(0);
    expect(result.quarantined).toBe(1);
    expect(result.quarantinedCandidates?.[0]?.error).toContain("externalUrl");
  });

  it("rejects off-host targets and unsafe external paths", async () => {
    expect(() => new WorkdayAdapter({ config: { companyName: "X", host: "evil.example.com", tenant: TENANT, site: SITE }, searchTerms: ["a b c"] })).toThrow();
    expect(() => new WorkdayAdapter({ config: { companyName: "X", host: "other.wd5.myworkdayjobs.com", tenant: TENANT, site: SITE }, searchTerms: ["a b c"] })).toThrow();
    expect(() => new WorkdayAdapter({ config: { companyName: "X", host: HOST, tenant: TENANT, site: "../x" }, searchTerms: ["a b c"] })).toThrow();

    const { calls } = fakeTenant({ hitsByTerm: { "data engineer": [{ ...hit("x"), externalPath: "//evil.example.com/job/x" }] } });
    const result = await adapter(["data engineer"]).fetchJobs({ limit: 5 });
    expect(result.success).toBe(false);
    expect(calls.every((call) => new URL(call.url).hostname === HOST)).toBe(true);
    expect(calls.every((call) => call.method === "GET" || call.method === "POST")).toBe(true);
  });

  it("waits between requests and stops when the shared run budget is spent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ total: 0, jobPostings: [], facets: [] })));
    const waits: number[] = [];
    const paced = new WorkdayAdapter({
      config: { companyName: "Example Corp", host: HOST, tenant: TENANT, site: SITE },
      searchTerms: ["data engineer"],
      limits: { requestDelayMs: 5_000 },
      sleep: async (ms) => { waits.push(ms); },
    });
    await paced.fetchJobs({ limit: 5 });
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.every((ms) => ms > 0 && ms <= 5_000)).toBe(true);

    let now = 0;
    const budget = workdayDeadlineBudget(1_000, () => now);
    now = 2_000;
    fakeTenant({ hitsByTerm: { "data engineer": [hit("a")] }, details: detailsFor(["a"]) });
    const spent = adapter(["data engineer"], {}, budget);
    const result = await spent.fetchJobs({ limit: 5 });
    expect(result).toMatchObject({ success: true, jobs: [], nextCursor: "wd:v1:0:0" });
    expect(spent.lastRunStats?.stoppedForBudget).toBe(true);
  });

  it("converts description HTML to text with paragraph breaks", () => {
    expect(workdayHtmlToText("<p>One&nbsp;line</p><p></p><p>Two <b>bold</b></p><style>x{}</style><br><br><br>Three"))
      .toBe("One line\nTwo bold\nThree");
    expect(workdayHtmlToText(null)).toBe("");
  });

  it("normalises search terms deterministically", () => {
    expect(workdaySearchTerms(["Data  Engineer", "data engineer", "AI Engineer", " "])).toEqual(["ai engineer", "data engineer"]);
  });
});

describe("Workday configuration", () => {
  it("validates Workday company entries", () => {
    const valid = { id: "x", name: "Example Corp", ats_provider: "workday", workday_host: HOST, workday_tenant: TENANT, workday_site: SITE, target_lanes: ["CORE_AI_DATA"] };
    expect(CompanyConfigSchema.safeParse(valid).success).toBe(true);
    expect(CompanyConfigSchema.safeParse({ ...valid, workday_site: undefined }).success).toBe(false);
    expect(CompanyConfigSchema.safeParse({ ...valid, workday_host: "examplecorp.example.com" }).success).toBe(false);
    expect(CompanyConfigSchema.safeParse({ ...valid, workday_host: "someoneelse.wd5.myworkdayjobs.com" }).success).toBe(false);
    expect(CompanyConfigSchema.safeParse({ id: "g", ats_provider: "greenhouse", board_slug: "g", workday_tenant: TENANT }).success).toBe(false);
  });

  it("loads the verified Workday tenants from config/companies.yml", () => {
    const workday = loadCompaniesConfig().filter((company) => company.ats_provider === "workday");
    expect(workday.length).toBeGreaterThan(0);
    for (const company of workday) {
      expect(company.workday_host?.startsWith(`${company.workday_tenant?.toLowerCase()}.`)).toBe(true);
      expect(company.target_lanes?.length).toBeGreaterThan(0);
    }
    expect(new Set(workday.map((company) => company.id)).size).toBe(workday.length);
  });

  it("registers the workday plugin and lane source keys", () => {
    const plugin = SourcePluginSchema.parse(load(readFileSync(path.resolve(process.cwd(), "config/source-plugins/workday.yml"), "utf8")));
    expect(plugin).toMatchObject({ source_key: "workday", kind: "ats", compliance: { access_basis: "undocumented_public_endpoint", authenticated_scraping: false } });
    const plan = loadSixLaneSourcePlanConfig();
    for (const lane of ["CORE_AI_DATA", "LEGAL_REGTECH", "HEALTH_BIO_PHARMA", "INVESTMENT_MARKETS_FINTECH"]) {
      expect(plan.lanes[lane].source_keys).toContain("workday");
    }
  });

  it("builds search terms from the lanes' role terms and target functions", () => {
    const plans = new DiscoveryScoutPlanner().generateSearchPlans();
    const terms = workdaySearchTermsForLanes(["INVESTMENT_MARKETS_FINTECH"], plans);
    expect(terms).toEqual(expect.arrayContaining([...plans.INVESTMENT_MARKETS_FINTECH.roleTerms, ...plans.INVESTMENT_MARKETS_FINTECH.targetFunctions]));
    expect(workdaySearchTermsForLanes(["UNKNOWN_LANE"], plans)).toEqual([]);
  });

  it("rotates tenants by UTC day", () => {
    expect(rotateDaily(["a", "b", "c"], new Date(0))).toEqual(["a", "b", "c"]);
    expect(rotateDaily(["a", "b", "c"], new Date(86_400_000))).toEqual(["b", "c", "a"]);
    expect(rotateDaily([], new Date())).toEqual([]);
  });
});
