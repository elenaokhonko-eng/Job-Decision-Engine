import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import {
  fetchJobContent,
  type PostingFetcherDependencies,
  type SafeHttpResponse,
} from "../../ingestion/jobContentFetcher.js";

const sampleDescription = [
  "The Head of AI Engineering sets technical direction for applied AI at NLTB Asia Pacific.",
  "Responsibilities",
  "Set reference designs, agree safe release practices, and chair design reviews for product and platform groups.",
  "Requirements",
  "11+ years of experience building and running software platforms.",
  "6+ years leading platform delivery on a major public cloud.",
  "3–5 years shipping machine learning or language-model services to production.",
  "The post also calls for clear influence with senior colleagues, model risk controls, and hands-on engineering depth.",
].join(" ");

const sampleHtml = [
  "<html><head>",
  '<script type="application/ld+json">',
  JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Head of AI Engineering",
    identifier: { propertyID: "NLTB", value: "7000000001" },
    hiringOrganization: { "@type": "Organization", name: "Northern Ledger Trading Bank" },
    description: "<h2>Responsibilities</h2><p>Set reference designs, agree safe release practices, and chair design reviews for product and platform groups.</p><h2>Requirements</h2><ul><li>11+ years of experience building and running software platforms.</li><li>6+ years leading platform delivery on a major public cloud.</li><li>3–5 years shipping machine learning or language-model services to production.</li></ul><p>The post also calls for clear influence with senior colleagues, model risk controls, and hands-on engineering depth.</p>",
    datePosted: "2026-10-24",
    jobLocation: { "@type": "Place", address: { addressLocality: "Singapore", addressCountry: "SG" } },
    url: "https://careers.nltb.example/NLTB/job/Head-of-AI-Engineering/7000000001/",
  }),
  "</script></head><body>",
  "<nav>Careers search navigation</nav>",
  "<div class=\"cookie-banner\">Accept cookies</div>",
  "<main>",
  "<h1>Head of AI Engineering</h1>",
  "<p>Location: Singapore</p>",
  "<p>Set reference designs, agree safe release practices, and chair design reviews for product and platform groups.</p>",
  "<p>Visitors can browse openings by team, city or contract length.</p>",
  "<p>11+ years building and running software platforms; 6+ years on a major public cloud; 3–5 years shipping machine learning services.</p>",
  "<p>Our recruiters reply within a fortnight, even when the answer is no.</p>",
  '<a href="/talentcommunity/apply/7000000001/?locale=en_US">Apply now »</a>',
  "</main><footer>Careers homepage</footer></body></html>",
].join("");

function response(
  url: string,
  status: number,
  body: string,
  headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" },
): SafeHttpResponse {
  return { url, status, headers, body: Buffer.from(body, "utf8") };
}

function publicAddress(hostname: string) {
  if (hostname === "127.0.0.1" || hostname === "localhost") return [{ address: "127.0.0.1", family: 4 }];
  return [{ address: "93.184.216.34", family: 4 }];
}

function htmlDependencies(html: string): PostingFetcherDependencies {
  return {
    resolveAddresses: async (host) => publicAddress(host),
    fetchOnce: async (url) => response(url.toString(), 200, html),
    now: () => new Date("2026-10-28T00:00:00.000Z"),
  };
}

describe("fetchJobContent", () => {
  it("extracts a job-specific NLTB posting and its explicit evidence", async () => {
    const result = await fetchJobContent(
      "https://careers.nltb.example/NLTB/job/Head-of-AI-Engineering/7000000001/",
      { title: "Head of AI Engineering", companyName: "NLTB", requisitionId: "7000000001" },
      htmlDependencies(sampleHtml),
    );

    expect(result.kind).toBe("COMPLETE");
    if (result.kind !== "COMPLETE") return;
    expect(result.posting.description).toContain("11+ years of experience");
    expect(result.posting.description).toContain("6+ years leading");
    expect(result.posting.description).toContain("3–5 years shipping");
    expect(result.posting.location).toContain("Singapore");
    expect(result.posting.applyUrl).toContain("/talentcommunity/apply/7000000001/");
    expect(result.posting.publishedAt).toBe("2026-10-24T00:00:00.000Z");
    expect(result.posting.availability).toBe("UNKNOWN");
    expect(result.provider.key).toBe("EMPLOYER_WEBSITE");
    expect(result.provider.requisitionId).toBe("7000000001");
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts a concise complete posting when both role sections are present", async () => {
    const html = '<html><body><main><h1>Data Governance Lead</h1><p>Responsibilities: Own governance operations, coordinate reviews, and deliver reporting.</p><p>Requirements: Strong SQL experience, clear writing, and practical policy knowledge.</p><p>Partner with data and risk teams to maintain controls.</p></main></body></html>';
    const result = await fetchJobContent(
      "https://example.org/jobs/data-governance-lead",
      { title: "Data Governance Lead", companyName: "Example Org" },
      htmlDependencies(html),
    );
    expect(result.kind).toBe("COMPLETE");
  });

  it("rejects unrelated JobPosting JSON-LD instead of choosing the longest description", async () => {
    const unrelated = '<script type="application/ld+json">' + JSON.stringify({
      "@type": "JobPosting",
      title: "Another Position",
      hiringOrganization: { name: "Example Org" },
      description: "A ".repeat(1000),
    }) + "</script><main><h1>Another Position</h1></main>";
    const result = await fetchJobContent(
      "https://example.org/jobs/not-the-requested-role",
      { title: "Data Governance Lead", companyName: "Example Org" },
      htmlDependencies(unrelated),
    );
    expect(result).toMatchObject({ kind: "IDENTITY_CONFLICT" });
  });

  it("uses the direct Lever record and preserves commercial and stakeholder evidence", async () => {
    const apiBody = JSON.stringify({
      id: "0f1e2d3c-4b5a-4968-8776-655443322110",
      text: "Analytics Delivery Lead — Client Programmes",
      hostedUrl: "https://jobs.lever.co/quillmark/0f1e2d3c-4b5a-4968-8776-655443322110",
      applyUrl: "https://jobs.lever.co/quillmark/0f1e2d3c-4b5a-4968-8776-655443322110/apply",
      categories: { location: "United States", commitment: "Full-time" },
      workplaceType: "remote",
      createdAt: Date.parse("2025-08-01T12:00:00Z"),
      salaryRange: { currency: "USD", interval: "per-year-salary", min: 120000, max: 160000 },
      descriptionPlain: "Run analytics engagements for client organisations, keeping scope, staffing and results on track.",
      lists: [
        { text: "Responsibilities", content: "<ul><li>Report progress to client review boards and brief their senior sponsors.</li><li>Hold the fee budget, delivery margin, and agreed results.</li></ul>" },
        { text: "Requirements", content: "<ul><li>Background running analytics work for advisory clients.</li><li>Sound planning and writing skills.</li></ul>" },
      ],
    });
    const requests: string[] = [];
    const result = await fetchJobContent(
      "https://jobs.lever.co/quillmark/0f1e2d3c-4b5a-4968-8776-655443322110",
      { title: "Analytics Delivery Lead — Client Programmes", companyName: "Quillmark", requisitionId: "0f1e2d3c-4b5a-4968-8776-655443322110" },
      {
        resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
        fetchOnce: async (url) => {
          requests.push(url.toString());
          return response(url.toString(), 200, apiBody, { "content-type": "application/json" });
        },
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("/v0/postings/quillmark/0f1e2d3c-4b5a-4968-8776-655443322110");
    expect(result.kind).toBe("COMPLETE");
    if (result.kind !== "COMPLETE") return;
    expect(result.posting.description).toContain("client review boards");
    expect(result.posting.description).toContain("fee budget");
    expect(result.provider.key).toBe("LEVER");
    expect(result.posting.publishedAt).toBe("2025-08-01T12:00:00.000Z");
    expect(result.posting.workplaceType).toBe("REMOTE");
    expect(result.posting.compensationRaw).toBe("USD 120000-160000 per year");
    expect(result.posting.availability).toBe("UNKNOWN");
    expect(result.posting.publishedAt).toBe("2025-08-01T12:00:00.000Z");
    expect(result.posting.workplaceType).toBe("REMOTE");
    expect(result.posting.compensationRaw).toBe("USD 120000-160000 per year");
    expect(result.posting.availability).toBe("UNKNOWN");
  });

  it("uses the exact Greenhouse requisition endpoint and validates its identity", async () => {
    const requests: string[] = [];
    const payload = {
      id: 12345,
      title: "Senior Data Architect",
      absolute_url: "https://boards.greenhouse.io/quillmark/jobs/12345",
      location: { name: "Singapore" },
      content: "<h2>Responsibilities</h2><p>Design and govern data platforms for regulated financial services teams.</p><h2>Qualifications</h2><p>Lead architecture reviews, document decisions, and work with engineers and business stakeholders.</p>",
      first_published: "2026-10-20T10:00:00Z",
    };
    const result = await fetchJobContent(
      "https://boards.greenhouse.io/quillmark/jobs/12345?gh_jid=12345",
      { title: "Senior Data Architect", companyName: "Quillmark", requisitionId: "12345" },
      {
        resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
        fetchOnce: async (url) => {
          requests.push(url.toString());
          return response(url.toString(), 200, JSON.stringify(payload), { "content-type": "application/json" });
        },
      },
    );

    expect(requests).toEqual([
      "https://boards-api.greenhouse.io/v1/boards/quillmark/jobs/12345?content=true",
    ]);
    expect(result.kind).toBe("COMPLETE");
    if (result.kind !== "COMPLETE") return;
    expect(result.provider).toMatchObject({ key: "GREENHOUSE", providerKey: "quillmark", requisitionId: "12345" });
    expect(result.posting.location).toBe("Singapore");
    expect(result.posting.publishedAt).toBe("2026-10-20T10:00:00.000Z");
    expect(result.posting.availability).toBe("UNKNOWN");
  });

  it("fetches and reuses one bounded Ashby board snapshot while selecting the exact requisition", async () => {
    const requests: string[] = [];
    const payload = { jobs: [
      {
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        title: "ML Platform Architect",
        companyName: "Example Bank",
        location: "Singapore",
        workplaceType: "Hybrid",
        publishedAt: "2025-07-01T00:00:00Z",
        compensation: {
          compensationTierSummary: "SGD 12000-15000 per month",
          compensationTiers: [{ components: [{
            summary: "SGD 12000-15000 per month",
            compensationType: "Salary",
            interval: "1 MONTH",
            currencyCode: "SGD",
            minValue: 12000,
            maxValue: 15000,
          }] }],
        },
        jobUrl: "https://jobs.ashbyhq.com/example-bank/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        descriptionHtml: "<h2>Responsibilities</h2><p>Design secure machine learning platforms, lead architecture reviews, and coordinate delivery.</p><h2>Requirements</h2><p>Experience with production data systems, model governance, and stakeholder communication.</p>",
      },
      {
        id: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        title: "ML Platform Architect",
        companyName: "Example Bank",
        isRemote: true,
        isListed: false,
        secondaryLocations: [{ location: "Remote - Singapore" }],
        jobUrl: "https://jobs.ashbyhq.com/example-bank/bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        descriptionHtml: "<h2>Responsibilities</h2><p>Design secure machine learning platforms and coordinate delivery with product teams.</p><h2>Requirements</h2><p>Experience with production data systems, model governance, and stakeholder communication.</p>",
      },
    ] };
    const dependencies: PostingFetcherDependencies = {
      resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchOnce: async (url) => {
        requests.push(url.toString());
        return response(url.toString(), 200, JSON.stringify(payload), { "content-type": "application/json" });
      },
      now: () => new Date("2026-10-28T00:00:00.000Z"),
    };
    const url = "https://jobs.ashbyhq.com/example-bank/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const expected = { title: "ML Platform Architect", companyName: "Example Bank" };
    const first = await fetchJobContent(url, expected, dependencies);
    const second = await fetchJobContent(url, expected, dependencies);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toBe("https://api.ashbyhq.com/posting-api/job-board/example-bank?includeCompensation=true");
    expect(first.kind).toBe("COMPLETE");
    expect(second.kind).toBe("COMPLETE");
    if (first.kind === "COMPLETE") expect(first.posting).toMatchObject({
      requisitionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      workplaceType: "HYBRID",
      publishedAt: "2025-07-01T00:00:00.000Z",
      compensationRaw: "SGD 12000-15000 per month",
      availability: "UNKNOWN",
    });
    const secondary = await fetchJobContent(
      "https://jobs.ashbyhq.com/example-bank/bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      { title: "ML Platform Architect", companyName: "Example Bank" },
      dependencies,
    );
    expect(secondary.kind).toBe("COMPLETE");
    if (secondary.kind === "COMPLETE") expect(secondary.posting).toMatchObject({
      location: "Remote - Singapore",
      workplaceType: "UNKNOWN",
      availability: "UNKNOWN",
    });
    if (first.kind === "COMPLETE") {
      expect(first.posting.rawPayload).toMatchObject({
        compensation: {
          compensationTiers: [{ components: [{ currencyCode: "SGD", interval: "1 MONTH", minValue: 12000, maxValue: 15000 }] }],
        },
      });
    }
  });

  it("extracts a SuccessFactors style JobPosting without navigation or footer text", async () => {
    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: "Cloud Integration Architect",
      identifier: { value: "7000000002" },
      hiringOrganization: { name: "Example Telecom" },
      description: "<h2>Responsibilities</h2><p>Plan how internal systems connect and see integration work through to release.</p><h2>Qualifications</h2><p>Design resilient integration layers, coach delivery squads, and explain trade-offs to non-specialists.</p>",
      datePosted: "2026-10-21",
      url: "https://careers.exampletelecom.example/job/Cloud-Integration-Architect-Sing/7000000002/",
    };
    const html = `<nav>Unrelated careers navigation</nav><script type="application/ld+json">${JSON.stringify(jsonLd)}</script><main><h1>Cloud Integration Architect</h1><p>Responsibilities and qualifications are available in the role details.</p></main><footer>Other vacancies</footer>`;
    const result = await fetchJobContent(
      "https://careers.exampletelecom.example/job/Cloud-Integration-Architect-Sing/7000000002/",
      { title: "Cloud Integration Architect", companyName: "Example Telecom", requisitionId: "7000000002" },
      htmlDependencies(html),
    );

    expect(result.kind).toBe("COMPLETE");
    if (result.kind !== "COMPLETE") return;
    expect(result.posting.description).toContain("Design resilient integration layers");
    expect(result.posting.description).not.toContain("Unrelated careers navigation");
    expect(result.posting.publishedAt).toBe("2026-10-21T00:00:00.000Z");
  });

  it("blocks direct private destinations and public-to-private redirects", async () => {
    const called: string[] = [];
    const privateTarget = await fetchJobContent(
      "http://127.0.0.1/admin",
      { title: "Admin Job", companyName: "Internal" },
      {
        resolveAddresses: async () => [{ address: "127.0.0.1", family: 4 }],
        fetchOnce: async (url) => {
          called.push(url.toString());
          return response(url.toString(), 200, sampleHtml);
        },
      },
    );
    expect(privateTarget).toMatchObject({ kind: "BLOCKED", reason: "UNSAFE_REDIRECT" });
    expect(called).toHaveLength(0);

    const redirectCalls: string[] = [];
    const redirected = await fetchJobContent(
      "https://public.example/jobs/1",
      { title: "Head of AI Engineering", companyName: "NLTB" },
      {
        resolveAddresses: async (host) => publicAddress(host),
        fetchOnce: async (url) => {
          redirectCalls.push(url.toString());
          return response(url.toString(), 302, "", { location: "http://127.0.0.1/metadata" });
        },
      },
    );
    expect(redirected).toMatchObject({ kind: "BLOCKED", reason: "UNSAFE_REDIRECT" });
    expect(redirectCalls).toHaveLength(1);
  });

  it("resolves hosts with the operating system resolver and still blocks private results", async () => {
    // localhost resolves from the hosts file with no network. Node's Resolver (direct DNS queries)
    // has no record for it and fails, as it did for every host on a machine whose DNS list pointed
    // at a local proxy that was not listening.
    const called: string[] = [];
    const result = await fetchJobContent(
      "https://localhost/jobs/1",
      { title: "Internal Job", companyName: "Internal" },
      { fetchOnce: async (url) => { called.push(url.toString()); return response(url.toString(), 200, sampleHtml); } },
    );
    expect(result).toMatchObject({ kind: "BLOCKED", reason: "UNSAFE_REDIRECT" });
    expect(called).toHaveLength(0);
  });

  it("revalidates special-purpose IPv4 and IPv6 redirect destinations", async () => {
    const targets = ["127.0.0.1", "169.254.169.254", "[::1]", "[fd00::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "[2001:db8::1]", "[3fff::1]"];
    for (const target of targets) {
      let requestCount = 0;
      const result = await fetchJobContent(
        "https://public.example/jobs/1",
        { title: "Role", companyName: "Example Org" },
        {
          resolveAddresses: async (host) => host === "public.example"
            ? [{ address: "93.184.216.34", family: 4 }]
            : [{ address: host.replace("[", "").replace("]", ""), family: host.includes(":") ? 6 : 4 }],
          fetchOnce: async (url) => {
            requestCount += 1;
            return response(url.toString(), 302, "", { location: `http://${target}/metadata` });
          },
        },
      );
      expect(result, target).toMatchObject({ kind: "BLOCKED", reason: "UNSAFE_REDIRECT" });
      expect(requestCount, target).toBe(1);
    }
  });

  it("blocks otherwise public URLs that target nonstandard service ports", async () => {
    const called: string[] = [];
    const result = await fetchJobContent(
      "https://public.example:5432/jobs/1",
      { title: "Role", companyName: "Example Org" },
      {
        resolveAddresses: async (host) => publicAddress(host),
        fetchOnce: async (url) => {
          called.push(url.toString());
          return response(url.toString(), 200, "");
        },
      },
    );
    expect(result).toMatchObject({ kind: "BLOCKED", reason: "UNSAFE_REDIRECT" });
    expect(called).toHaveLength(0);
  });

  it("returns explicit unavailable and retryable outcomes", async () => {
    const unavailable = await fetchJobContent(
      "https://example.org/jobs/1",
      { title: "Role", companyName: "Example Org" },
      { ...htmlDependencies(""), fetchOnce: async (url) => response(url.toString(), 404, "") },
    );
    expect(unavailable).toMatchObject({ kind: "UNAVAILABLE" });

    const limited = await fetchJobContent(
      "https://example.org/jobs/1",
      { title: "Role", companyName: "Example Org" },
      {
        ...htmlDependencies(""),
        fetchOnce: async (url) => response(url.toString(), 429, "", { "retry-after": "60" }),
      },
    );
    expect(limited).toMatchObject({
      kind: "RETRYABLE_FAILURE",
      retryAfter: "2026-10-28T00:01:00.000Z",
    });
  });

  it("does not accept a sign-in shell as full job content", async () => {
    const login = "<html><body><main><h1>Data Governance Lead</h1><p>Sign in to continue to this posting.</p></main></body></html>";
    const result = await fetchJobContent(
      "https://example.org/jobs/data-governance-lead",
      { title: "Data Governance Lead", companyName: "Example Org" },
      htmlDependencies(login),
    );
    expect(result).toMatchObject({ kind: "BLOCKED", reason: "AUTH_REQUIRED" });
  });

  it("rejects generic company careers copy even when it is longer than a title snippet", async () => {
    const generic = [
      "Example Org is a global company with a diverse team and a collaborative culture.",
      "We offer competitive benefits, professional development, flexible programs, and opportunities to make an impact.",
      "Our values include integrity, respect, inclusion, teamwork, innovation, and service to our customers.",
      "Join our talent community to learn about future opportunities and hear from our people.",
      "We are an equal opportunity employer and welcome applicants from every background.",
      "Explore our locations, teams, stories, events, benefits, and frequently asked questions.",
      "Candidate privacy information and accommodation details are available on our careers website.",
    ].join(" ");
    expect(generic.split(/\s+/).length).toBeGreaterThanOrEqual(50);
    expect(generic.split(/\s+/).length).toBeLessThanOrEqual(100);
    const html = `<html><body><main><h1>Data Governance Lead</h1><p>${generic}</p></main></body></html>`;
    const result = await fetchJobContent(
      "https://example.org/jobs/data-governance-lead",
      { title: "Data Governance Lead", companyName: "Example Org" },
      htmlDependencies(html),
    );
    expect(result).toMatchObject({ kind: "BLOCKED", reason: "UNSUPPORTED_SOURCE" });
  });

  it("applies one deadline to DNS and a body that continuously drips bytes", async () => {
    let dnsAborted = false;
    const dnsResult = await fetchJobContent(
      "https://public.example/jobs/1",
      { title: "Data Governance Lead", companyName: "Example Org" },
      {
        totalTimeoutMs: 20,
        resolveAddresses: async (_hostname, signal) => await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            dnsAborted = true;
            reject(new Error("DNS cancelled by request deadline."));
          }, { once: true });
        }),
        fetchOnce: async () => { throw new Error("The request must not start before DNS resolves."); },
      },
    );
    expect(dnsResult.kind).toBe("RETRYABLE_FAILURE");
    expect(dnsAborted).toBe(true);

    const server = createServer((_request, responseStream) => {
      responseStream.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const drip = setInterval(() => responseStream.write("posting bytes "), 5);
      responseStream.on("close", () => clearInterval(drip));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("The drip server did not bind a TCP port.");
      const result = await fetchJobContent(
        "https://public.example/jobs/1",
        { title: "Data Governance Lead", companyName: "Example Org" },
        {
          totalTimeoutMs: 60,
          resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
          fetchOnce: async (url, _timeoutMs, _addresses, signal) => {
            const response = await fetch(`http://127.0.0.1:${address.port}/drip`, { signal });
            return {
              url: url.toString(),
              status: response.status,
              headers: { "content-type": response.headers.get("content-type") ?? "" },
              body: Buffer.from(await response.arrayBuffer()),
            };
          },
        },
      );
      expect(result.kind).toBe("RETRYABLE_FAILURE");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
