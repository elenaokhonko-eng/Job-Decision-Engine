import { afterEach, describe, expect, it, vi } from "vitest";
import { JobicyAdapter } from "../../ingestion/adapters/jobicyAdapter.js";
import { RemotiveAdapter } from "../../ingestion/adapters/remotiveAdapter.js";
import { createWeWorkRemotelyAdapter } from "../../ingestion/adapters/attributedRssAdapter.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public source adapters", () => {
  it("maps Jobicy jobs, strips HTML, and preserves identity/raw payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ jobs: [{
      id: 42,
      companyName: "Example AI",
      jobTitle: "Staff ML Engineer",
      jobGeo: "Worldwide",
      jobType: "full-time",
      url: "https://jobicy.example/jobs/42",
      jobDescription: "<p>Build <strong>ML</strong> systems.</p>",
      pubDate: "2026-09-01T00:00:00Z"
    }] })));

    const result = await new JobicyAdapter("https://jobicy.example/api").fetchJobs({ limit: 10 });
    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].source_external_id).toBe("42");
    expect(result.jobs[0].description_raw).toBe("Build ML systems.");
    expect(result.jobs[0].raw_payload).toMatchObject({ id: 42 });
    expect(result.jobs[0].source_attribution).toBe("Jobicy");
  });

  it("quarantines malformed Jobicy records", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ jobs: [{ id: 1, companyName: "Bad" }] })));
    const result = await new JobicyAdapter("https://jobicy.example/api").fetchJobs();
    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(0);
    expect(result.quarantined).toBe(1);
  });

  it("reports Jobicy rate limiting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    const result = await new JobicyAdapter("https://jobicy.example/api").fetchJobs();
    expect(result.success).toBe(false);
    expect(result.isRateLimited).toBe(true);
  });

  it("reports Jobicy timeout", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const adapter = new JobicyAdapter("https://jobicy.example/api");
    (adapter as any).timeoutMs = 1;
    const result = await adapter.fetchJobs();
    expect(result.success).toBe(false);
    expect(result.error).toContain("Timeout");
  });

  it("treats an empty Jobicy response as a successful zero-result run", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ jobs: [] })));
    const result = await new JobicyAdapter("https://jobicy.example/api").fetchJobs();
    expect(result.success).toBe(true);
    expect(result.totalFetched).toBe(0);
    expect(result.jobs).toHaveLength(0);
  });

  it("marks Remotive records with attribution and delayed-feed metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ jobs: [{
      id: 9,
      company_name: "Remote Co",
      title: "Data Engineer",
      candidate_required_location: "Worldwide",
      job_type: "full_time",
      url: "https://remotive.example/job/9",
      description: "<p>Build data systems</p>",
      publication_date: "2026-09-01T00:00:00Z"
    }] })));
    const result = await new RemotiveAdapter("https://remotive.example/api").fetchJobs();
    expect(result.jobs[0].feed_delay_hours).toBe(24);
    expect(result.jobs[0].source_attribution).toContain("Remotive");
  });

  it("parses attributed We Work Remotely RSS records", async () => {
    const rss = `<?xml version="1.0"?><rss><channel><item><guid>wwr-1</guid><title>Acme: AI Engineer</title><link>https://weworkremotely.example/jobs/1</link><description><![CDATA[<p>Build agents</p>]]></description><pubDate>Tue, 01 Sep 2026 00:00:00 GMT</pubDate></item></channel></rss>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(rss, { status: 200 })));
    const result = await createWeWorkRemotelyAdapter("https://weworkremotely.example/feed").fetchJobs();
    expect(result.success).toBe(true);
    expect(result.jobs[0]).toMatchObject({
      company_name: "Acme",
      title: "AI Engineer",
      source_attribution: "We Work Remotely - canonical source link required"
    });
  });
});
