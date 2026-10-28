import { afterEach, describe, expect, it, vi } from "vitest";
import { SchemaOrgAdapter } from "../../ingestion/adapters/schemaOrgAdapter.js";

const endpoint = "https://careerasia.smbc.co.jp/SMBC/job/Director%2C-AI-Solution-Architect/1441267233/";

afterEach(() => vi.unstubAllGlobals());

describe("SMBC schema.org job adapter", () => {
  it("extracts a JSON-LD JobPosting and preserves published date evidence", async () => {
    const html = `<!doctype html><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "JobPosting",
      identifier: "1441267233",
      title: "Director, AI Solution Architect",
      description: "<p>Design enterprise AI workflows and integrations.</p>",
      datePosted: "2026-10-24",
      hiringOrganization: { "@type": "Organization", name: "SMBC" },
      jobLocation: { "@type": "Place", address: { addressLocality: "Singapore" } },
      employmentType: "FULL_TIME",
    })}</script>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, { status: 200 })));

    const result = await new SchemaOrgAdapter(endpoint).fetchJobs({ limit: 1 });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      source_external_id: "1441267233",
      company_name: "SMBC",
      title: "Director, AI Solution Architect",
      location_raw: "Singapore",
      workplace_type_raw: "UNKNOWN",
      employment_type_raw: "FULL_TIME",
      compensation_raw: "UNKNOWN",
      description_raw: "Design enterprise AI workflows and integrations.",
      published_at: "2026-10-24T00:00:00.000Z",
    });
    expect(result.jobs[0].raw_payload).toMatchObject({ datePosted: "2026-10-24" });
  });

  it("extracts a microdata JobPosting without inferring attendance or salary", async () => {
    const html = `<!doctype html><div itemscope itemtype="https://schema.org/JobPosting">
      <h1 itemprop="title">Director, AI Solution Architect</h1>
      <meta itemprop="identifier" content="1441267233">
      <meta itemprop="datePosted" content="2026-10-24">
      <div itemprop="hiringOrganization" itemscope itemtype="https://schema.org/Organization"><span itemprop="name">SMBC</span></div>
      <div itemprop="jobLocation" itemscope itemtype="https://schema.org/Place">
        <div itemprop="address" itemscope itemtype="https://schema.org/PostalAddress"><meta itemprop="streetAddress" content="Singapore"></div>
      </div>
      <div itemprop="description"><p>Build enterprise AI workflows.</p><p>Integrate secure platforms.</p></div>
    </div>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, { status: 200 })));

    const result = await new SchemaOrgAdapter(endpoint).fetchJobs();

    expect(result.success).toBe(true);
    expect(result.jobs[0]).toMatchObject({
      company_name: "SMBC",
      location_raw: "Singapore",
      workplace_type_raw: "UNKNOWN",
      compensation_raw: "UNKNOWN",
      description_raw: "Build enterprise AI workflows. Integrate secure platforms.",
      published_at: "2026-10-24T00:00:00.000Z",
    });
  });

  it("rejects unverified hosts and refuses cross-host redirects", async () => {
    expect(() => new SchemaOrgAdapter("https://example.org/job/1")).toThrow(/verified HTTPS SMBC Careers/);
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://example.org/redirected" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new SchemaOrgAdapter(endpoint).fetchJobs();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/redirected outside its verified HTTPS host/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
