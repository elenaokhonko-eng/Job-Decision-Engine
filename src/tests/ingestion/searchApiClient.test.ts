import { describe, expect, it, vi } from "vitest";
import {
  linkedInJobIdFromUrl,
  parseSearchApiDailyCreditCap,
  SearchApiClient,
  searchApiLinkedInDetailsFromEnv,
  type SearchApiCreditLedger,
} from "../../ingestion/searchApi/searchApiClient.js";

const API_KEY = "test-searchapi-key-not-real";

function memoryLedger(capacity = Number.POSITIVE_INFINITY) {
  const reservations: { engine: string; purpose: string; requestKey: string }[] = [];
  const completions: { id: string; httpStatus: number | null; succeeded: boolean; errorDetail?: string }[] = [];
  const ledger: SearchApiCreditLedger = {
    async reserve(input) {
      if (reservations.length >= Math.min(capacity, input.dailyCreditCap)) return null;
      reservations.push({ engine: input.engine, purpose: input.purpose, requestKey: input.requestKey });
      return `ledger-${reservations.length}`;
    },
    async complete(id, outcome) {
      completions.push({ id, ...outcome });
    },
  };
  return { ledger, reservations, completions };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const DETAIL = {
  job_id: "4000000001",
  title: "Synthetic Data Architect",
  company_name: "Example Analytics Pte Ltd",
  location: "Singapore (Hybrid)",
  description: "Synthetic fixture description.",
};

describe("SearchApiClient", () => {
  it("authenticates with a bearer header and keeps the key out of the URL, ledger and evidence", async () => {
    const { ledger, reservations, completions } = memoryLedger();
    const fetchImpl = vi.fn(async () => jsonResponse(200, { jobs: [{ job_id: 4000000001, title: "A", company_name: "B" }] }));
    const client = new SearchApiClient({ apiKey: API_KEY, ledger, dailyCreditCap: 10, fetchImpl });

    const result = await client.searchLinkedInJobs({ q: '"data architect"', location: "Singapore", timePeriod: "last_day" }, "DISCOVERY");

    expect(result.kind).toBe("OK");
    if (result.kind !== "OK") return;
    expect(result.data.jobs[0]?.job_id).toBe("4000000001");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("engine")).toBe("linkedin_jobs");
    expect(parsed.searchParams.get("location")).toBe("Singapore");
    expect(parsed.searchParams.get("time_period")).toBe("last_day");
    expect(url).not.toContain(API_KEY);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(init.redirect).toBe("error");
    expect(JSON.stringify({ reservations, completions, evidence: result.evidence })).not.toContain(API_KEY);
    expect(reservations).toEqual([{ engine: "linkedin_jobs", purpose: "DISCOVERY", requestKey: 'linkedin_jobs:last_day|Singapore|"data architect"' }]);
    expect(completions).toEqual([{ id: "ledger-1", httpStatus: 200, succeeded: true }]);
  });

  it("sends nothing once the daily credit cap is spent", async () => {
    const { ledger } = memoryLedger(0);
    const fetchImpl = vi.fn();
    const client = new SearchApiClient({ apiKey: API_KEY, ledger, dailyCreditCap: 5, fetchImpl });

    const result = await client.linkedInJobDetails("4000000001", "CONTENT_FETCH");

    expect(result).toEqual({ kind: "BUDGET_EXHAUSTED", reason: "SearchAPI daily credit cap of 5 is spent." });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a missing jobs array as schema drift unless the provider reports zero results", async () => {
    const { ledger } = memoryLedger();
    const drift = new SearchApiClient({ apiKey: API_KEY, ledger, dailyCreditCap: 10, fetchImpl: vi.fn(async () => jsonResponse(200, { search_information: { total_results: 12 } })) });
    const empty = new SearchApiClient({ apiKey: API_KEY, ledger, dailyCreditCap: 10, fetchImpl: vi.fn(async () => jsonResponse(200, { search_information: { total_results: 0 } })) });
    const params = { q: "x", location: "Singapore", timePeriod: "last_day" as const };

    const driftResult = await drift.searchLinkedInJobs(params, "DISCOVERY");
    const emptyResult = await empty.searchLinkedInJobs(params, "DISCOVERY");

    expect(driftResult).toMatchObject({ kind: "FAILED", retryable: true });
    expect(emptyResult).toMatchObject({ kind: "OK", data: { jobs: [] } });
  });

  it("rejects details whose job id differs from the requested job", async () => {
    const { ledger, completions } = memoryLedger();
    const client = new SearchApiClient({
      apiKey: API_KEY, ledger, dailyCreditCap: 10,
      fetchImpl: vi.fn(async () => jsonResponse(200, { job: { ...DETAIL, job_id: "4000000099" } })),
    });

    const result = await client.linkedInJobDetails("4000000001", "DISCOVERY");

    expect(result).toMatchObject({ kind: "FAILED", retryable: true });
    expect(completions[0]).toMatchObject({ succeeded: false });
  });

  it("marks an unknown job as not retryable and other HTTP failures as retryable, redacting the key", async () => {
    const { ledger } = memoryLedger();
    const notFound = new SearchApiClient({ apiKey: API_KEY, ledger, dailyCreditCap: 10, fetchImpl: vi.fn(async () => jsonResponse(404, { error: "Job not found." })) });
    const unauthorized = new SearchApiClient({ apiKey: API_KEY, ledger, dailyCreditCap: 10, fetchImpl: vi.fn(async () => jsonResponse(401, { error: `Invalid key ${API_KEY}` })) });

    const missing = await notFound.linkedInJobDetails("4000000001", "CONTENT_FETCH");
    const denied = await unauthorized.linkedInJobDetails("4000000001", "CONTENT_FETCH");

    expect(missing).toMatchObject({ kind: "FAILED", httpStatus: 404, retryable: false });
    expect(denied).toMatchObject({ kind: "FAILED", httpStatus: 401, retryable: true });
    expect(JSON.stringify(denied)).not.toContain(API_KEY);
  });

  it("records a network failure against the reserved credit", async () => {
    const { ledger, completions } = memoryLedger();
    const client = new SearchApiClient({ apiKey: API_KEY, ledger, dailyCreditCap: 10, fetchImpl: vi.fn(async () => { throw new Error("socket hang up"); }) });

    const result = await client.linkedInJobDetails("4000000001", "DISCOVERY");

    expect(result).toMatchObject({ kind: "FAILED", httpStatus: null, retryable: true });
    expect(completions).toEqual([expect.objectContaining({ id: "ledger-1", succeeded: false })]);
  });
});

describe("SearchAPI configuration helpers", () => {
  it("extracts LinkedIn job ids only from LinkedIn job URLs", () => {
    expect(linkedInJobIdFromUrl("https://www.linkedin.com/jobs/view/4000000001/?trk=x")).toBe("4000000001");
    expect(linkedInJobIdFromUrl("https://sg.linkedin.com/jobs/view/synthetic-data-architect-at-example-4000000002")).toBe("4000000002");
    expect(linkedInJobIdFromUrl("https://www.linkedin.com/comm/jobs/view/4000000003")).toBe("4000000003");
    expect(linkedInJobIdFromUrl("https://www.linkedin.com/jobs/search/?currentJobId=4000000004")).toBe("4000000004");
    expect(linkedInJobIdFromUrl("https://example.com/jobs/view/4000000005")).toBeNull();
    expect(linkedInJobIdFromUrl("not a url")).toBeNull();
  });

  it("parses the daily credit cap strictly", () => {
    expect(parseSearchApiDailyCreditCap(undefined)).toBe(60);
    expect(parseSearchApiDailyCreditCap("150")).toBe(150);
    expect(() => parseSearchApiDailyCreditCap("0")).toThrow(/SEARCHAPI_DAILY_CREDIT_CAP/);
    expect(() => parseSearchApiDailyCreditCap("ten")).toThrow(/SEARCHAPI_DAILY_CREDIT_CAP/);
  });

  it("enables content-fetch details only when the flag and key are both set", () => {
    const executor = { query: vi.fn() };
    expect(searchApiLinkedInDetailsFromEnv({}, executor as never)).toBeUndefined();
    expect(searchApiLinkedInDetailsFromEnv({ SEARCHAPI_API_KEY: API_KEY }, executor as never)).toBeUndefined();
    expect(searchApiLinkedInDetailsFromEnv({ SEARCHAPI_LINKEDIN_ENABLED: "true" }, executor as never)).toBeUndefined();
    expect(typeof searchApiLinkedInDetailsFromEnv({ SEARCHAPI_LINKEDIN_ENABLED: "true", SEARCHAPI_API_KEY: API_KEY }, executor as never)).toBe("function");
  });
});
