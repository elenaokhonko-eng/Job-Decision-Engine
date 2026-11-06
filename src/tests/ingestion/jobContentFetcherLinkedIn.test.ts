import { describe, expect, it, vi } from "vitest";
import { fetchJobContent, type PostingFetcherDependencies } from "../../ingestion/jobContentFetcher.js";
import type { LinkedInJobDetail, SearchApiCallResult } from "../../ingestion/searchApi/searchApiClient.js";

const NOW = new Date("2026-11-07T05:30:00.000Z");
const JOB_ID = "4000000001";
const DESCRIPTION = [
  "About the role: Example Analytics is building a synthetic data platform for regional teams.",
  "Responsibilities: lead the architecture of data pipelines, review designs, and coordinate delivery with engineering squads.",
  "Requirements: experience designing cloud data platforms, strong stakeholder communication, and production delivery skills.",
].join("\n");

const EVIDENCE = {
  requestUrl: `https://www.searchapi.io/api/v1/search?engine=linkedin_job_details&job_id=${JOB_ID}`,
  httpStatus: 200,
  retrievedAt: NOW.toISOString(),
  responseHash: "b".repeat(64),
  ledgerRequestId: "ledger-1",
};

function detail(overrides: Partial<LinkedInJobDetail> = {}): SearchApiCallResult<LinkedInJobDetail> {
  const job = {
    job_id: JOB_ID,
    title: "Synthetic Data Architect",
    company_name: "Example Analytics",
    location: "Singapore (Hybrid)",
    employment_type: "Full-time",
    description: DESCRIPTION,
    ...overrides,
  } as LinkedInJobDetail;
  return { kind: "OK", data: job, raw: { job }, evidence: EVIDENCE };
}

function dependencies(result: SearchApiCallResult<LinkedInJobDetail>) {
  const linkedInJobDetails = vi.fn(async () => result);
  const fetchOnce = vi.fn();
  const deps: PostingFetcherDependencies = { linkedInJobDetails, fetchOnce, now: () => NOW };
  return { deps, linkedInJobDetails, fetchOnce };
}

const EXPECTED = { title: "Synthetic Data Architect", companyName: "Example Analytics" };

describe("fetchJobContent for LinkedIn URLs through SearchAPI", () => {
  it("returns a complete LinkedIn posting bound to the canonical job URL without fetching LinkedIn", async () => {
    const { deps, linkedInJobDetails, fetchOnce } = dependencies(detail());

    const result = await fetchJobContent(`https://www.linkedin.com/comm/jobs/view/${JOB_ID}/?trk=alert`, EXPECTED, deps);

    expect(linkedInJobDetails).toHaveBeenCalledWith(JOB_ID);
    expect(fetchOnce).not.toHaveBeenCalled();
    expect(result.kind).toBe("COMPLETE");
    if (result.kind !== "COMPLETE") return;
    expect(result.provider).toEqual({
      key: "LINKEDIN",
      sourceUrl: `https://www.linkedin.com/comm/jobs/view/${JOB_ID}/?trk=alert`,
      canonicalUrl: `https://www.linkedin.com/jobs/view/${JOB_ID}`,
      requisitionId: JOB_ID,
      providerKey: "searchapi",
    });
    expect(result.posting).toMatchObject({
      description: DESCRIPTION,
      canonicalUrl: `https://www.linkedin.com/jobs/view/${JOB_ID}`,
      workplaceType: "HYBRID",
      publishedAt: null,
      availability: "UNKNOWN",
    });
    expect(result.evidence).toMatchObject({
      requestedUrl: `https://www.linkedin.com/comm/jobs/view/${JOB_ID}/?trk=alert`,
      resolvedUrl: EVIDENCE.requestUrl,
      httpStatus: 200,
      responseHash: EVIDENCE.responseHash,
    });
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reports an identity conflict when LinkedIn returns a different title", async () => {
    const { deps } = dependencies(detail({ title: "Different Role" }));

    const result = await fetchJobContent(`https://www.linkedin.com/jobs/view/${JOB_ID}`, EXPECTED, deps);

    expect(result.kind).toBe("IDENTITY_CONFLICT");
  });

  it("keeps a thin LinkedIn description blocked rather than complete", async () => {
    const { deps } = dependencies(detail({ description: "Short teaser text." }));

    const result = await fetchJobContent(`https://www.linkedin.com/jobs/view/${JOB_ID}`, EXPECTED, deps);

    expect(result).toEqual({ kind: "BLOCKED", reason: "UNSUPPORTED_SOURCE" });
  });

  it("retries after the next UTC midnight when the credit cap is spent", async () => {
    const { deps } = dependencies({ kind: "BUDGET_EXHAUSTED", reason: "SearchAPI daily credit cap of 60 is spent." });

    const result = await fetchJobContent(`https://www.linkedin.com/jobs/view/${JOB_ID}`, EXPECTED, deps);

    expect(result).toEqual({
      kind: "RETRYABLE_FAILURE",
      reason: "SearchAPI daily credit cap of 60 is spent.",
      retryAfter: "2026-11-08T00:00:00.000Z",
    });
  });

  it("maps provider outages to retryable and unknown jobs to unavailable", async () => {
    const outage = dependencies({ kind: "FAILED", httpStatus: 503, retryable: true, reason: "HTTP 503" });
    const missing = dependencies({ kind: "FAILED", httpStatus: 404, retryable: false, reason: "Job not found." });

    const retry = await fetchJobContent(`https://www.linkedin.com/jobs/view/${JOB_ID}`, EXPECTED, outage.deps);
    const gone = await fetchJobContent(`https://www.linkedin.com/jobs/view/${JOB_ID}`, EXPECTED, missing.deps);

    expect(retry).toEqual({ kind: "RETRYABLE_FAILURE", reason: "HTTP 503" });
    expect(gone).toMatchObject({ kind: "UNAVAILABLE", reason: "Job not found.", evidence: { httpStatus: 404 } });
  });

  it("does not use SearchAPI for non-LinkedIn URLs", async () => {
    const { deps, linkedInJobDetails } = dependencies(detail());
    const fetchOnce = vi.fn(async () => ({ status: 404, headers: {}, body: Buffer.alloc(0), url: "https://careers.example.com/jobs/1" }));

    await fetchJobContent("https://careers.example.com/jobs/1", EXPECTED, {
      ...deps,
      fetchOnce,
      resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(linkedInJobDetails).not.toHaveBeenCalled();
    expect(fetchOnce).toHaveBeenCalled();
  });
});
