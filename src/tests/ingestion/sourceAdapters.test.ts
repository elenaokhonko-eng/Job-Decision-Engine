import { afterEach, describe, expect, it, vi } from "vitest";
import { JobicyAdapter } from "../../ingestion/adapters/jobicyAdapter.js";
import { GreenhouseAdapter } from "../../ingestion/adapters/greenhouseAdapter.js";
import { LeverAdapter } from "../../ingestion/adapters/leverAdapter.js";
import { AshbyAdapter } from "../../ingestion/adapters/ashbyAdapter.js";
import { HimalayasAdapter } from "../../ingestion/adapters/himalayasAdapter.js";
import { RemotiveAdapter } from "../../ingestion/adapters/remotiveAdapter.js";
import { createWeWorkRemotelyAdapter } from "../../ingestion/adapters/attributedRssAdapter.js";
import { stripHtmlToText } from "../../security/sanitize.js";

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
  it("removes script and style blocks with non-canonical closing tags", () => {
    expect(stripHtmlToText("<script>untrusted</script >Visible <style>hidden</style foo=\"bar\">text")).toBe("Visible text");
  });

  it("maps Jobicy jobs, strips HTML, and preserves identity/raw payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ jobs: [{
      id: 42,
      companyName: "Example AI",
      jobTitle: "Staff ML Engineer",
      jobGeo: "Worldwide",
      jobType: ["full-time", "permanent"],
      url: "https://jobicy.example/jobs/42",
      applicationUrl: "https://apply.example.test/jobs/42",
      jobDescription: "<p>Build <strong>ML</strong> systems.</p><script>alert(1)</script >",
      pubDate: "2026-09-01T00:00:00Z"
    }] })));

    const result = await new JobicyAdapter("https://jobicy.example/api").fetchJobs({ limit: 10 });
    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].source_external_id).toBe("42");
    expect(result.jobs[0].employment_type_raw).toBe("full-time, permanent");
    expect(result.jobs[0].description_raw).toBe("Build ML systems.");
    expect(result.jobs[0].raw_payload).toMatchObject({ id: 42 });
    expect(result.jobs[0].employer_posting_url).toBe("https://jobicy.example/jobs/42");
    expect(result.jobs[0].application_url).toBe("https://apply.example.test/jobs/42");
    expect(result.jobs[0].canonical_apply_url).toBe("https://apply.example.test/jobs/42");
    expect(result.jobs[0].source_attribution).toBe("Jobicy");
  });

  it("resumes a full Greenhouse board snapshot beyond the first page without duplicating postings", async () => {
    const records = Array.from({ length: 61 }, (_, index) => {
      const id = String(index + 1).padStart(4, "0");
      return {
        id,
        title: `Technical Platform Role ${id}`,
        location: { name: "Singapore" },
        absolute_url: `https://boards.greenhouse.io/example/jobs/${id}`,
        content: "Build and maintain a technical data platform with engineering and architecture responsibilities.",
      };
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ jobs: records })));
    const adapter = new GreenhouseAdapter("example");
    const allIds: string[] = [];
    let cursor: string | null = null;
    let calls = 0;

    do {
      const result = await adapter.fetchJobs({ limit: 30, cursor });
      expect(result.success).toBe(true);
      allIds.push(...result.jobs.map((job) => job.source_external_id ?? ""));
      cursor = result.nextCursor ?? null;
      calls++;
      expect(calls).toBeLessThanOrEqual(3);
    } while (cursor !== null);

    expect(allIds).toHaveLength(61);
    expect(new Set(allIds).size).toBe(61);
    expect(allIds).toContain("0061");
  });

  it("keeps Lever posting and application URLs distinct", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([{
      id: "lever-42",
      text: "Solutions Architect",
      hostedUrl: "https://jobs.lever.co/example/lever-42",
      applyUrl: "https://apply.lever.co/example/lever-42",
      categories: { location: "Singapore", commitment: "Full-time" },
      descriptionPlain: "Architect technical platforms.",
    }])));

    const result = await new LeverAdapter("example").fetchJobs();

    expect(result.jobs[0].employer_posting_url).toBe("https://jobs.lever.co/example/lever-42");
    expect(result.jobs[0].application_url).toBe("https://apply.lever.co/example/lever-42");
    expect(result.jobs[0].canonical_apply_url).toBe("https://apply.lever.co/example/lever-42");
  });

  it("keeps Ashby posting and application URLs distinct", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ jobs: [{
      id: "ashby-42",
      title: "Platform Architect",
      jobUrl: "https://jobs.ashbyhq.com/example/ashby-42",
      applyUrl: "https://apply.ashbyhq.com/example/ashby-42",
      description: "Architect data platforms.",
    }] })));

    const result = await new AshbyAdapter("example").fetchJobs();

    expect(result.jobs[0].employer_posting_url).toBe("https://jobs.ashbyhq.com/example/ashby-42");
    expect(result.jobs[0].application_url).toBe("https://apply.ashbyhq.com/example/ashby-42");
    expect(result.jobs[0].canonical_apply_url).toBe("https://apply.ashbyhq.com/example/ashby-42");
  });

  it("quarantines malformed Jobicy records", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ jobs: [{ id: 1, companyName: "Bad" }] })));
    const result = await new JobicyAdapter("https://jobicy.example/api").fetchJobs();
    expect(result.success).toBe(false);
    expect(result.jobs).toHaveLength(0);
    expect(result.quarantined).toBe(1);
  });

  it("keeps valid Jobicy records when the upstream id is blank", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ jobs: [{
      id: "",
      companyName: "Example AI",
      jobTitle: "Data Engineer",
      url: "https://jobicy.example/jobs/data-engineer",
      jobDescription: "Build production data pipelines remotely."
    }] })));

    const result = await new JobicyAdapter("https://jobicy.example/api").fetchJobs();
    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].source_external_id).toBe("https://jobicy.example/jobs/data-engineer");
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

  it("preserves Himalayas jobs when the feed omits an external id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ jobs: [{
      companyName: "Himalayas AI",
      title: "Data Platform Lead",
      jobUrl: "https://himalayas.example/jobs/data-platform-lead",
      applicationUrl: "https://apply.example.test/jobs/data-platform-lead",
      description: "Build production data platforms remotely."
    }] })));
    const result = await new HimalayasAdapter("https://himalayas.example/api").fetchJobs();
    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].source_external_id).toBe("https://himalayas.example/jobs/data-platform-lead");
    expect(result.jobs[0].employer_posting_url).toBe("https://himalayas.example/jobs/data-platform-lead");
    expect(result.jobs[0].application_url).toBe("https://apply.example.test/jobs/data-platform-lead");
    expect(result.jobs[0].canonical_apply_url).toBe("https://apply.example.test/jobs/data-platform-lead");
    expect(result.totalFetched).toBe(1);
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
