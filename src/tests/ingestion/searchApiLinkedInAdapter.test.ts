import { describe, expect, it, vi } from "vitest";
import {
  linkedInSearchQueries,
  loadSearchApiLinkedInPlan,
  SearchApiLinkedInAdapter,
  type LinkedInSearchQuery,
} from "../../ingestion/adapters/searchApiLinkedInAdapter.js";
import type { SearchApiCallResult, SearchApiClient } from "../../ingestion/searchApi/searchApiClient.js";
import { REQUIRED_DISCOVERY_LANES } from "../../ingestion/discoveryPlanConfig.js";
import { searchApiLinkedInSetup } from "../../../scripts/run_adapters.js";

const EVIDENCE = {
  requestUrl: "https://www.searchapi.io/api/v1/search?engine=linkedin_job_details&job_id=1",
  httpStatus: 200,
  retrievedAt: "2026-11-07T02:00:00.000Z",
  responseHash: "a".repeat(64),
  ledgerRequestId: "ledger",
};

function summary(jobId: string) {
  return { job_id: jobId, title: `Synthetic Role ${jobId}`, company_name: "Example Systems", location: "Singapore" };
}

function detail(jobId: string) {
  return {
    job_id: jobId,
    title: `Synthetic Role ${jobId}`,
    company_name: "Example Systems",
    location: "Singapore (Hybrid)",
    employment_type: "Full-time",
    salary: "SGD 10,000 - 12,000 per month",
    description: "<p>Responsibilities: design synthetic platforms.</p><p>Requirements: synthetic experience.</p>",
  };
}

function fakeClient(options: {
  searches: Record<string, SearchApiCallResult<{ jobs: ReturnType<typeof summary>[] }>>;
  details?: (jobId: string) => SearchApiCallResult<ReturnType<typeof detail>>;
}) {
  const searchLinkedInJobs = vi.fn(async (params: { q: string; location: string }) =>
    options.searches[`${params.location}|${params.q}`] ?? { kind: "OK" as const, data: { jobs: [] }, raw: {}, evidence: EVIDENCE });
  const linkedInJobDetails = vi.fn(async (jobId: string) =>
    options.details?.(jobId) ?? { kind: "OK" as const, data: detail(jobId), raw: { job: detail(jobId) }, evidence: EVIDENCE });
  return { client: { searchLinkedInJobs, linkedInJobDetails } as unknown as SearchApiClient, searchLinkedInJobs, linkedInJobDetails };
}

const QUERIES: LinkedInSearchQuery[] = [
  { queryId: "CORE_AI_DATA:singapore", laneKey: "CORE_AI_DATA", q: "q1", location: "Singapore" },
  { queryId: "CORE_AI_DATA:remote_apac", laneKey: "CORE_AI_DATA", q: "(q1) remote", location: "Asia Pacific" },
];

function ok(jobs: ReturnType<typeof summary>[]) {
  return { kind: "OK" as const, data: { jobs }, raw: { jobs }, evidence: EVIDENCE };
}

describe("SearchApiLinkedInAdapter", () => {
  it("dedupes across queries, skips observed ids, and stages full descriptions under the LinkedIn source", async () => {
    const { client, linkedInJobDetails } = fakeClient({
      searches: {
        "Singapore|q1": ok([summary("4000000001"), summary("4000000002")]),
        "Asia Pacific|(q1) remote": ok([summary("4000000002"), summary("4000000003")]),
      },
    });
    const findObservedJobIds = vi.fn(async () => new Set(["4000000003"]));
    const adapter = new SearchApiLinkedInAdapter({ client, queries: QUERIES, timePeriod: "last_day", maxDetailsPerRun: 10, findObservedJobIds });

    const result = await adapter.fetchJobs();

    expect(findObservedJobIds).toHaveBeenCalledWith(["4000000001", "4000000002", "4000000003"]);
    expect(linkedInJobDetails.mock.calls.map(([jobId]) => jobId)).toEqual(["4000000001", "4000000002"]);
    expect(result).toMatchObject({ sourceName: "LINKEDIN", success: true, totalFetched: 2, snapshotTotal: 3, hasMore: false });
    expect(result.jobs).toHaveLength(2);
    const [first, second] = result.jobs;
    expect(first).toMatchObject({
      source_external_id: "https://www.linkedin.com/jobs/view/4000000001",
      canonical_apply_url: "https://www.linkedin.com/jobs/view/4000000001",
      workplace_type_raw: "HYBRID",
      employment_type_raw: "Full-time",
      compensation_raw: "SGD 10,000 - 12,000 per month",
    });
    expect(first?.description_raw).toContain("Responsibilities: design synthetic platforms.");
    expect(first?.description_raw).not.toContain("<p>");
    expect((second?.raw_payload as { matched_query_ids: string[] }).matched_query_ids).toEqual(["CORE_AI_DATA:singapore", "CORE_AI_DATA:remote_apac"]);
    expect(adapter.lastRunStats).toEqual({
      searchesSent: 2, searchesFailed: 0, candidates: 3, alreadyObserved: 1,
      detailsFetched: 2, detailsFailed: 0, deferredForBudget: 0, budgetExhausted: false,
    });
  });

  it("defers ids beyond the per-run details budget instead of staging snippets", async () => {
    const { client, linkedInJobDetails } = fakeClient({
      searches: { "Singapore|q1": ok([summary("4000000001"), summary("4000000002"), summary("4000000003")]) },
    });
    const adapter = new SearchApiLinkedInAdapter({
      client, queries: [QUERIES[0]!], timePeriod: "last_day", maxDetailsPerRun: 1, findObservedJobIds: async () => new Set(),
    });

    const result = await adapter.fetchJobs();

    expect(linkedInJobDetails).toHaveBeenCalledTimes(1);
    expect(result.jobs).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(adapter.lastRunStats?.deferredForBudget).toBe(2);
  });

  it("stops at the daily credit cap without treating it as a source failure", async () => {
    const { client, linkedInJobDetails } = fakeClient({
      searches: { "Singapore|q1": ok([summary("4000000001"), summary("4000000002")]) },
      details: (jobId) => jobId === "4000000002"
        ? { kind: "BUDGET_EXHAUSTED", reason: "cap" }
        : { kind: "OK", data: detail(jobId), raw: {}, evidence: EVIDENCE },
    });
    const adapter = new SearchApiLinkedInAdapter({
      client, queries: QUERIES, timePeriod: "last_day", maxDetailsPerRun: 10, findObservedJobIds: async () => new Set(),
    });

    const result = await adapter.fetchJobs();

    expect(linkedInJobDetails).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.source_external_id)).toEqual(["https://www.linkedin.com/jobs/view/4000000001"]);
    expect(adapter.lastRunStats).toMatchObject({ budgetExhausted: true, deferredForBudget: 1 });
  });

  it("fails the run on provider errors while keeping the postings it did retrieve", async () => {
    const { client } = fakeClient({
      searches: {
        "Singapore|q1": ok([summary("4000000001"), summary("4000000002")]),
        "Asia Pacific|(q1) remote": { kind: "FAILED", httpStatus: 503, retryable: true, reason: "HTTP 503" },
      },
      details: (jobId) => jobId === "4000000002"
        ? { kind: "FAILED", httpStatus: 500, retryable: true, reason: "HTTP 500" }
        : { kind: "OK", data: detail(jobId), raw: {}, evidence: EVIDENCE },
    });
    const adapter = new SearchApiLinkedInAdapter({
      client, queries: QUERIES, timePeriod: "last_day", maxDetailsPerRun: 10, findObservedJobIds: async () => new Set(),
    });

    const result = await adapter.fetchJobs();

    expect(result.success).toBe(false);
    expect(result.jobs).toHaveLength(1);
    expect(result.error).toContain("search CORE_AI_DATA:remote_apac: HTTP 503");
    expect(result.error).toContain("details 4000000002: HTTP 500");
  });

  it("states work mode only when LinkedIn labels it", async () => {
    const { client } = fakeClient({
      searches: { "Singapore|q1": ok([summary("4000000001")]) },
      details: (jobId) => ({ kind: "OK", data: { ...detail(jobId), location: "Singapore" }, raw: {}, evidence: EVIDENCE }),
    });
    const adapter = new SearchApiLinkedInAdapter({
      client, queries: [QUERIES[0]!], timePeriod: "last_day", maxDetailsPerRun: 5, findObservedJobIds: async () => new Set(),
    });

    const result = await adapter.fetchJobs();

    expect(result.jobs[0]?.workplace_type_raw).toBe("UNKNOWN");
  });
});

describe("SearchAPI LinkedIn plan and setup", () => {
  it("covers every discovery lane in Singapore and remote APAC within the daily credit cap", () => {
    const plan = loadSearchApiLinkedInPlan();
    const queries = linkedInSearchQueries(plan, REQUIRED_DISCOVERY_LANES);

    expect(new Set(queries.map((query) => query.laneKey))).toEqual(new Set(REQUIRED_DISCOVERY_LANES));
    expect(queries).toHaveLength(REQUIRED_DISCOVERY_LANES.length * 2);
    expect(new Set(queries.map((query) => query.location))).toEqual(new Set(["Singapore", "Asia Pacific"]));
    expect(queries.filter((query) => query.location === "Asia Pacific").every((query) => query.q.endsWith(" remote"))).toBe(true);
    expect(queries.every((query) => query.q.length <= 500)).toBe(true);
    expect(queries.length + plan.max_details_per_run).toBeLessThanOrEqual(60);
  });

  it("stays dormant until enabled and refuses to run enabled without a key", () => {
    const broker = { findObservedLinkedInJobIds: vi.fn(async () => new Set<string>()) };
    const executor = { query: vi.fn() };
    const laneKeys = ["CORE_AI_DATA"];

    expect(searchApiLinkedInSetup({ env: {}, broker, ledgerExecutor: executor as never, laneKeys }).kind).toBe("DISABLED");
    expect(searchApiLinkedInSetup({ env: { SEARCHAPI_LINKEDIN_ENABLED: "true" }, broker, ledgerExecutor: executor as never, laneKeys }))
      .toEqual({ kind: "MISCONFIGURED", reason: "SEARCHAPI_LINKEDIN_ENABLED is true but SEARCHAPI_API_KEY is not set." });
    expect(searchApiLinkedInSetup({
      env: { SEARCHAPI_LINKEDIN_ENABLED: "true", SEARCHAPI_API_KEY: "k", SEARCHAPI_DAILY_CREDIT_CAP: "0" },
      broker, ledgerExecutor: executor as never, laneKeys,
    }).kind).toBe("MISCONFIGURED");
    expect(searchApiLinkedInSetup({
      env: { SEARCHAPI_LINKEDIN_ENABLED: "true", SEARCHAPI_API_KEY: "k" }, broker, ledgerExecutor: executor as never, laneKeys,
    }).kind).toBe("READY");
    expect(executor.query).not.toHaveBeenCalled();
  });
});
