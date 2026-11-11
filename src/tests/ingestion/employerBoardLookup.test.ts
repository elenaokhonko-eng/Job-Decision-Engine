import { describe, expect, it } from "vitest";
import {
  fetchJobContent,
  type ExpectedPostingIdentity,
  type PostingFetcherDependencies,
  type SafeHttpResponse,
} from "../../ingestion/jobContentFetcher.js";
import {
  InMemoryEmployerBoardResolutionCache,
  createEmployerBoardFallback,
  deriveBoardSlugCandidates,
  employerKey,
  loadKnownEmployerBoards,
  locationsCompatible,
  type KnownEmployerBoard,
} from "../../ingestion/employerBoardLookup.js";
import type { LinkedInJobDetail, SearchApiCallResult } from "../../ingestion/searchApi/searchApiClient.js";

// Synthetic employers, titles and descriptions only.
const NOW = new Date("2026-11-07T06:00:00.000Z");
const JOB_ID = "4000000123";
const LINKEDIN_URL = `https://www.linkedin.com/comm/jobs/view/${JOB_ID}/?trk=alert`;
const DESCRIPTION = [
  "<p>About the role: Example Analytics is building a synthetic data platform for regional operations teams.</p>",
  "<h3>Responsibilities</h3><ul><li>Lead the architecture of data pipelines and review designs with engineering squads.</li>",
  "<li>Coordinate delivery with product owners, document decisions and manage production risks.</li></ul>",
  "<h3>Requirements</h3><ul><li>Experience designing cloud data platforms and streaming systems in production.</li>",
  "<li>Strong stakeholder communication, mentoring and delivery skills across distributed teams.</li></ul>",
].join("");

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

interface Transport {
  readonly deps: PostingFetcherDependencies;
  readonly requests: string[];
}

function transport(route: (url: URL) => Reply | undefined, extra: Partial<PostingFetcherDependencies> = {}): Transport {
  const requests: string[] = [];
  const deps: PostingFetcherDependencies = {
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    now: () => NOW,
    fetchOnce: async (url): Promise<SafeHttpResponse> => {
      requests.push(url.toString());
      const reply = route(url) ?? { status: 404, body: { error: "not found" } };
      if (reply instanceof Error) throw reply;
      const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {});
      return {
        url: url.toString(),
        status: reply.status,
        headers: reply.headers ?? { "content-type": "application/json" },
        body: Buffer.from(body, "utf8"),
      };
    },
    ...extra,
  };
  return { deps, requests };
}

/** LinkedIn serves the sign-in wall to the posting fetcher, as it does from CI. */
function isLinkedInRequest(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "linkedin.com" || host.endsWith(".linkedin.com");
}

function linkedInAuthWall(url: URL): Reply | undefined {
  if (url.hostname === "www.linkedin.com") {
    return { status: 403, body: "<html>Sign in to view this job</html>", headers: { "content-type": "text/html" } };
  }
  return undefined;
}

function greenhouseJob(id: number, title: string, location: string, token = "exampleanalytics") {
  return {
    id,
    title,
    company_name: "Example Analytics",
    location: { name: location },
    absolute_url: `https://job-boards.greenhouse.io/${token}/jobs/${id}`,
    updated_at: "2026-11-01T00:00:00Z",
  };
}

function greenhouseBoard(
  jobs: ReturnType<typeof greenhouseJob>[],
  options: { token?: string; boardName?: string } = {},
): (url: URL) => Reply | undefined {
  const token = options.token ?? "exampleanalytics";
  const base = `/v1/boards/${token}`;
  return (url) => {
    const linkedIn = linkedInAuthWall(url);
    if (linkedIn) return linkedIn;
    if (url.hostname !== "boards-api.greenhouse.io") return undefined;
    if (url.pathname === base) return { status: 200, body: { name: options.boardName ?? "Example Analytics", content: "" } };
    if (url.pathname === `${base}/jobs`) return { status: 200, body: { jobs, meta: { total: jobs.length } } };
    const detail = url.pathname.match(new RegExp(`^${base}/jobs/(\\d+)$`))?.[1];
    const job = jobs.find((item) => String(item.id) === detail);
    if (job && url.searchParams.get("content") === "true") {
      return { status: 200, body: { ...job, content: DESCRIPTION } };
    }
    return undefined;
  };
}

const EXPECTED: ExpectedPostingIdentity = {
  title: "Synthetic Data Architect",
  companyName: "Example Analytics Pte. Ltd.",
  location: "Singapore, Singapore (Hybrid)",
};

function fallback(knownBoards: KnownEmployerBoard[] = [], cache = new InMemoryEmployerBoardResolutionCache()) {
  return { cache, employerBoardFallback: createEmployerBoardFallback({ cache, knownBoards }) };
}

describe("employer board slug derivation", () => {
  it("strips legal suffixes and produces joined and hyphenated candidates", () => {
    expect(deriveBoardSlugCandidates("Example Analytics Pte. Ltd.").map((item) => item.slug))
      .toEqual(["exampleanalytics", "example-analytics"]);
    expect(deriveBoardSlugCandidates("The Example Company, Inc.").map((item) => item.slug)).toEqual(["example"]);
    expect(deriveBoardSlugCandidates("Café Ünicode & Partners LLC").map((item) => item.slug))
      .toEqual(["cafeunicodeandpartners", "cafe-unicode-and-partners"]);
  });

  it("tries descriptor-free stems, but only distinctive ones on providers without an employer name", () => {
    expect(deriveBoardSlugCandidates("Northwind Technologies Group Ltd")).toEqual([
      { slug: "northwindtechnologiesgroup", unverifiedProviderSafe: true },
      { slug: "northwind", unverifiedProviderSafe: true },
      { slug: "northwind-technologies-group", unverifiedProviderSafe: true },
    ]);
    expect(deriveBoardSlugCandidates("Scale AI")).toEqual([
      { slug: "scaleai", unverifiedProviderSafe: true },
      { slug: "scale", unverifiedProviderSafe: false },
      { slug: "scale-ai", unverifiedProviderSafe: true },
    ]);
    expect(deriveBoardSlugCandidates("  ")).toEqual([]);
    expect(deriveBoardSlugCandidates("Northwind Technologies Group Ltd", 1)).toHaveLength(1);
  });

  it("keys employers by name without legal-form suffixes", () => {
    expect(employerKey("Example Analytics Pte. Ltd.")).toBe("example analytics");
    expect(employerKey("EXAMPLE ANALYTICS")).toBe("example analytics");
    expect(employerKey("Unknown Company")).toBe("unknown");
  });

  it("compares discovery and posting locations without inventing a match", () => {
    expect(locationsCompatible("Singapore, Singapore (Hybrid)", ["Singapore"])).toBe(true);
    expect(locationsCompatible("Greater Singapore Area", ["Singapore; Remote"])).toBe(true);
    expect(locationsCompatible("United States (Remote)", ["Remote - US"])).toBe(true);
    expect(locationsCompatible("San Francisco, CA", ["San Francisco, CA | Seattle, WA"])).toBe(true);
    expect(locationsCompatible("Singapore", ["London, United Kingdom"])).toBe(false);
    expect(locationsCompatible("New York, NY", ["Newark, NJ"])).toBe(false);
    expect(locationsCompatible(null, ["London"])).toBe(true);
    expect(locationsCompatible("Unknown", ["London"])).toBe(true);
    expect(locationsCompatible("Singapore", [null])).toBe(true);
  });

  it("reads known greenhouse, lever and ashby boards from the company registry", () => {
    const boards = loadKnownEmployerBoards();
    expect(boards.length).toBeGreaterThan(0);
    expect(boards.every((board) => ["GREENHOUSE", "LEVER", "ASHBY"].includes(board.provider))).toBe(true);
    // Registry slugs may contain dots (Ashby `mistral.ai`) but never path separators.
    expect(boards.every((board) => /^[a-z0-9][a-z0-9._-]*$/i.test(board.boardToken))).toBe(true);
  });
});

describe("fetchJobContent employer-board fallback for LinkedIn URLs", () => {
  it("finds the single matching Greenhouse posting from a verified derived slug", async () => {
    const jobs = [
      greenhouseJob(101, "Synthetic Data Architect", "Singapore"),
      greenhouseJob(102, "Synthetic Data Architect", "London, United Kingdom"),
      greenhouseJob(103, "Platform Engineer", "Singapore"),
    ];
    const { deps, requests } = transport(greenhouseBoard(jobs));
    const { cache, employerBoardFallback } = fallback();

    const result = await fetchJobContent(LINKEDIN_URL, EXPECTED, { ...deps, employerBoardFallback });

    expect(result.kind).toBe("COMPLETE");
    if (result.kind !== "COMPLETE") return;
    expect(result.provider).toMatchObject({
      key: "GREENHOUSE",
      canonicalUrl: "https://job-boards.greenhouse.io/exampleanalytics/jobs/101",
      requisitionId: "101",
      providerKey: "exampleanalytics",
    });
    expect(result.posting).toMatchObject({
      title: "Synthetic Data Architect",
      companyName: "Example Analytics",
      canonicalUrl: "https://job-boards.greenhouse.io/exampleanalytics/jobs/101",
      applyUrl: "https://job-boards.greenhouse.io/exampleanalytics/jobs/101",
      location: "Singapore",
    });
    expect(result.posting.description).toContain("Responsibilities");
    // The discovery identity stays the LinkedIn URL; the employer API is the transport endpoint.
    expect(result.evidence.requestedUrl).toBe(LINKEDIN_URL);
    expect(result.evidence.resolvedUrl).toBe("https://boards-api.greenhouse.io/v1/boards/exampleanalytics/jobs/101?content=true");
    expect(result.employerBoardLookup).toEqual({
      linkedInJobId: JOB_ID,
      provider: "GREENHOUSE",
      boardToken: "exampleanalytics",
      employerKey: "example analytics",
      resolutionMethod: "DERIVED_SLUG",
      resolutionCached: false,
    });
    // The board list is read without content; only the matched job's detail carries it.
    expect(requests).toContain("https://boards-api.greenhouse.io/v1/boards/exampleanalytics/jobs");
    expect(requests.filter((url) => url.includes("content=true"))).toEqual([
      "https://boards-api.greenhouse.io/v1/boards/exampleanalytics/jobs/101?content=true",
    ]);
    expect(cache.entries.get("example analytics")).toMatchObject({
      status: "FOUND",
      provider: "GREENHOUSE",
      boardToken: "exampleanalytics",
      resolutionMethod: "DERIVED_SLUG",
      expiresAt: "2026-12-07T06:00:00.000Z",
    });
  });

  it("reuses the cached board for the employer's next job without probing again", async () => {
    const jobs = [greenhouseJob(101, "Synthetic Data Architect", "Singapore"), greenhouseJob(103, "Platform Engineer", "Singapore")];
    const { cache, employerBoardFallback } = fallback();
    await fetchJobContent(LINKEDIN_URL, EXPECTED, { ...transport(greenhouseBoard(jobs)).deps, employerBoardFallback });

    const second = transport(greenhouseBoard(jobs));
    const result = await fetchJobContent(`https://www.linkedin.com/jobs/view/4000000124`, {
      ...EXPECTED,
      title: "Platform Engineer",
    }, { ...second.deps, employerBoardFallback });

    expect(result.kind).toBe("COMPLETE");
    if (result.kind === "COMPLETE") expect(result.employerBoardLookup?.resolutionCached).toBe(true);
    expect(second.requests).not.toContain("https://boards-api.greenhouse.io/v1/boards/exampleanalytics");
    expect(second.requests.filter((url) => url.includes("greenhouse"))).toHaveLength(2);
    expect(cache.entries.size).toBe(1);
  });

  it("reports more than one compatible posting as ambiguous instead of choosing one", async () => {
    const jobs = [
      greenhouseJob(101, "Synthetic Data Architect", "Singapore"),
      greenhouseJob(104, "Synthetic Data Architect", "Singapore; Remote"),
    ];
    const { deps } = transport(greenhouseBoard(jobs));
    const result = await fetchJobContent(LINKEDIN_URL, EXPECTED, { ...deps, ...fallback() });

    expect(result).toMatchObject({ kind: "BLOCKED", reason: "EMPLOYER_BOARD_AMBIGUOUS" });
    if (result.kind === "BLOCKED") expect(result.detail).toContain("LinkedIn page: AUTH_REQUIRED");
  });

  it("reports a board without the title at a compatible location as no match", async () => {
    const jobs = [
      greenhouseJob(102, "Synthetic Data Architect", "London, United Kingdom"),
      greenhouseJob(103, "Platform Engineer", "Singapore"),
    ];
    const { deps } = transport(greenhouseBoard(jobs));
    const result = await fetchJobContent(LINKEDIN_URL, EXPECTED, { ...deps, ...fallback() });

    expect(result).toMatchObject({ kind: "BLOCKED", reason: "EMPLOYER_BOARD_NO_MATCH" });
  });

  it("skips a guessed Greenhouse board that belongs to a different employer", async () => {
    const { deps } = transport(greenhouseBoard([greenhouseJob(101, "Synthetic Data Architect", "Singapore")], {
      boardName: "Unrelated Ventures",
    }));
    const { cache, employerBoardFallback } = fallback();
    const result = await fetchJobContent(LINKEDIN_URL, EXPECTED, { ...deps, employerBoardFallback });

    expect(result).toMatchObject({ kind: "BLOCKED", reason: "EMPLOYER_BOARD_NOT_FOUND" });
    expect(cache.entries.get("example analytics")?.status).toBe("NOT_FOUND");
  });

  it("caches a negative resolution so the next job of the employer sends no board requests", async () => {
    const first = transport(linkedInAuthWall);
    const { cache, employerBoardFallback } = fallback();
    const result = await fetchJobContent(LINKEDIN_URL, EXPECTED, { ...first.deps, employerBoardFallback });

    expect(result).toMatchObject({ kind: "BLOCKED", reason: "EMPLOYER_BOARD_NOT_FOUND" });
    // Greenhouse (verified) gets every candidate; Lever and Ashby only full-name slugs.
    expect(first.requests.filter((url) => !isLinkedInRequest(url))).toEqual([
      "https://boards-api.greenhouse.io/v1/boards/exampleanalytics",
      "https://boards-api.greenhouse.io/v1/boards/example-analytics",
      "https://api.ashbyhq.com/posting-api/job-board/exampleanalytics?includeCompensation=true",
      "https://api.ashbyhq.com/posting-api/job-board/example-analytics?includeCompensation=true",
      "https://api.lever.co/v0/postings/exampleanalytics?mode=json&skip=0&limit=50",
      "https://api.lever.co/v0/postings/example-analytics?mode=json&skip=0&limit=50",
    ]);
    expect(cache.entries.get("example analytics")).toMatchObject({
      status: "NOT_FOUND",
      expiresAt: "2026-11-14T06:00:00.000Z",
    });

    const second = transport(linkedInAuthWall);
    const again = await fetchJobContent(LINKEDIN_URL, EXPECTED, { ...second.deps, employerBoardFallback });
    expect(again).toMatchObject({ kind: "BLOCKED", reason: "EMPLOYER_BOARD_NOT_FOUND" });
    expect(second.requests.every((url) => isLinkedInRequest(url))).toBe(true);
  });

  it("keeps network, HTTP and parse failures retryable and caches nothing", async () => {
    const cases: Array<{ reply: Reply; retryAfter?: string }> = [
      { reply: new Error("socket hang up") },
      { reply: { status: 503, body: { error: "unavailable" } } },
      { reply: { status: 429, body: {}, headers: { "retry-after": "120" } }, retryAfter: "2026-11-07T06:02:00.000Z" },
      { reply: { status: 200, body: "{not json" } },
    ];
    for (const testCase of cases) {
      const { deps } = transport((url) => linkedInAuthWall(url) ?? (url.hostname === "boards-api.greenhouse.io" ? testCase.reply : undefined));
      const { cache, employerBoardFallback } = fallback();
      const result = await fetchJobContent(LINKEDIN_URL, EXPECTED, { ...deps, employerBoardFallback });
      expect(result.kind).toBe("RETRYABLE_FAILURE");
      if (result.kind === "RETRYABLE_FAILURE" && testCase.retryAfter) expect(result.retryAfter).toBe(testCase.retryAfter);
      expect(cache.entries.size).toBe(0);
    }
  });

  it("scans paginated Lever boards and keeps the card's employer name", async () => {
    const filler = Array.from({ length: 50 }, (_, index) => ({
      id: `filler-${index}`,
      text: `Filler Role ${index}`,
      categories: { location: "Singapore", allLocations: ["Singapore"] },
    }));
    const match = {
      id: "6d2a3c51-0000-4000-8000-000000000001",
      text: "Synthetic Data Architect",
      hostedUrl: "https://jobs.lever.co/exampleanalytics/6d2a3c51-0000-4000-8000-000000000001",
      applyUrl: "https://jobs.lever.co/exampleanalytics/6d2a3c51-0000-4000-8000-000000000001/apply",
      categories: { location: "Singapore, Singapore", commitment: "Full-time", allLocations: ["Singapore, Singapore"] },
      workplaceType: "hybrid",
      createdAt: Date.parse("2026-10-30T00:00:00Z"),
      description: DESCRIPTION,
    };
    const { deps, requests } = transport((url) => {
      const linkedIn = linkedInAuthWall(url);
      if (linkedIn) return linkedIn;
      if (url.hostname === "api.lever.co" && url.pathname === "/v0/postings/exampleanalytics") {
        return { status: 200, body: url.searchParams.get("skip") === "0" ? filler : [match] };
      }
      return undefined;
    });

    const result = await fetchJobContent(LINKEDIN_URL, EXPECTED, { ...deps, ...fallback() });

    expect(result.kind).toBe("COMPLETE");
    if (result.kind !== "COMPLETE") return;
    expect(result.provider).toMatchObject({ key: "LEVER", canonicalUrl: match.hostedUrl, providerKey: "exampleanalytics" });
    expect(result.posting).toMatchObject({
      companyName: "Example Analytics Pte. Ltd.",
      workplaceType: "HYBRID",
      applyUrl: match.applyUrl,
    });
    expect(result.evidence.resolvedUrl).toBe("https://api.lever.co/v0/postings/exampleanalytics?mode=json&skip=50&limit=50");
    expect(requests).toContain("https://api.lever.co/v0/postings/exampleanalytics?mode=json&skip=50&limit=50");
  });

  it("uses a configured Ashby board from the company registry", async () => {
    const job = {
      id: "0f5b8a3e-0000-4000-8000-0000000000aa",
      title: "Synthetic Data Architect",
      location: "Singapore",
      isListed: true,
      workplaceType: "Hybrid",
      employmentType: "FullTime",
      jobUrl: "https://jobs.ashbyhq.com/example-board/0f5b8a3e-0000-4000-8000-0000000000aa",
      applyUrl: "https://jobs.ashbyhq.com/example-board/0f5b8a3e-0000-4000-8000-0000000000aa/application",
      descriptionHtml: DESCRIPTION,
    };
    const { deps, requests } = transport((url) => linkedInAuthWall(url) ?? (
      url.hostname === "api.ashbyhq.com" && url.pathname === "/posting-api/job-board/example-board"
        ? { status: 200, body: { jobs: [job, { ...job, id: "other", title: "Other Role" }], apiVersion: "1" } }
        : undefined
    ));
    const { cache, employerBoardFallback } = fallback([
      { companyName: "Example Analytics", provider: "ASHBY", boardToken: "example-board" },
    ]);

    const result = await fetchJobContent(LINKEDIN_URL, EXPECTED, { ...deps, employerBoardFallback });

    expect(result.kind).toBe("COMPLETE");
    if (result.kind !== "COMPLETE") return;
    expect(result.posting).toMatchObject({
      canonicalUrl: job.jobUrl,
      applyUrl: job.applyUrl,
      companyName: "Example Analytics Pte. Ltd.",
      requisitionId: job.id,
    });
    expect(result.employerBoardLookup).toMatchObject({ resolutionMethod: "CONFIG", boardToken: "example-board" });
    expect(requests.filter((url) => !isLinkedInRequest(url))).toHaveLength(1);
    expect(cache.entries.get("example analytics")?.candidatesTried).toEqual(["ASHBY:example-board"]);
  });

  it("re-resolves a cached board that no longer exists", async () => {
    const cache = new InMemoryEmployerBoardResolutionCache();
    await cache.put({
      employerKey: "example analytics",
      employerName: "Example Analytics",
      status: "FOUND",
      provider: "LEVER",
      boardToken: "retired-board",
      boardName: null,
      resolutionMethod: "DERIVED_SLUG",
      candidatesTried: ["LEVER:retired-board"],
      resolvedAt: "2026-11-01T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z",
    });
    const { deps } = transport(greenhouseBoard([greenhouseJob(101, "Synthetic Data Architect", "Singapore")]));
    const result = await fetchJobContent(LINKEDIN_URL, EXPECTED, {
      ...deps,
      employerBoardFallback: createEmployerBoardFallback({ cache, knownBoards: [] }),
    });

    expect(result.kind).toBe("COMPLETE");
    expect(cache.entries.get("example analytics")).toMatchObject({ provider: "GREENHOUSE", boardToken: "exampleanalytics" });
  });

  it("does not run when SearchAPI is configured, for non-LinkedIn URLs, or for removed and conflicting postings", async () => {
    let calls = 0;
    const employerBoardFallback = async () => {
      calls += 1;
      return { kind: "BLOCKED" as const, reason: "EMPLOYER_BOARD_NOT_FOUND" as const };
    };
    const detail: SearchApiCallResult<LinkedInJobDetail> = {
      kind: "FAILED", httpStatus: 503, retryable: true, reason: "SearchAPI unavailable",
    };
    const withSearchApi = await fetchJobContent(LINKEDIN_URL, EXPECTED, {
      ...transport(linkedInAuthWall).deps,
      linkedInJobDetails: async () => detail,
      employerBoardFallback,
    });
    expect(withSearchApi.kind).toBe("RETRYABLE_FAILURE");

    const employerUrl = await fetchJobContent("https://careers.example.test/jobs/1", EXPECTED, {
      ...transport(() => ({ status: 403, body: "Sign in", headers: { "content-type": "text/html" } })).deps,
      employerBoardFallback,
    });
    expect(employerUrl).toMatchObject({ kind: "BLOCKED", reason: "AUTH_REQUIRED" });

    const removed = await fetchJobContent(LINKEDIN_URL, EXPECTED, {
      ...transport(() => ({ status: 404, body: "gone", headers: { "content-type": "text/html" } })).deps,
      employerBoardFallback,
    });
    expect(removed.kind).toBe("UNAVAILABLE");
    expect(calls).toBe(0);
  });

  it.each([
    "Unknown Company",
    "logo_100_100/company-logo_100_100/0/1631425624819/example_logo?e=2147483647&v=beta&t=abc",
  ])("refuses to look up a card without a usable employer name (%s)", async (companyName) => {
    const { deps, requests } = transport(linkedInAuthWall);
    const result = await fetchJobContent(LINKEDIN_URL, { ...EXPECTED, companyName }, {
      ...deps,
      ...fallback(),
    });
    expect(result).toMatchObject({ kind: "BLOCKED", reason: "EMPLOYER_BOARD_NOT_FOUND" });
    expect(requests.every((url) => isLinkedInRequest(url))).toBe(true);
  });
});
