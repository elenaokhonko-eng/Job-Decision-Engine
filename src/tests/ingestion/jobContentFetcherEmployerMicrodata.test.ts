import { describe, expect, it } from "vitest";
import {
  fetchJobContent,
  type ExpectedPostingIdentity,
  type JobContentResult,
} from "../../ingestion/jobContentFetcher.js";

/*
 * Synthetic employer career-site pages that mimic the markup of SAP
 * SuccessFactors Career Site Builder job pages (schema.org JobPosting
 * microdata, data-careersite-propertyid fields, "<Role> Job Details |
 * <Employer>" document titles). Employers, roles and copy are invented.
 */

const POSTING_URL = "https://careers.examplegroupbank.example/EGB/job/Synthetic-Platform-Lead/4100000001/";

const description = [
  "<p>Example Group Bank is building a synthetic platform team for deterministic tests.</p>",
  "<p><strong>Responsibilities</strong></p>",
  "<ul><li>Lead the design and delivery of the synthetic data platform across regional technology teams.</li>",
  "<li>Define engineering standards, review architecture decisions and own the platform roadmap.</li>",
  "<li>Partner with risk, operations and product stakeholders to plan quarterly delivery.</li></ul>",
  "<p><strong>Requirements</strong></p>",
  "<ul><li>10+ years of experience in software engineering or platform engineering roles.</li>",
  "<li>Experience leading teams that operate cloud data platforms in a regulated environment.</li>",
  "<li>Strong written communication and stakeholder management skills.</li></ul>",
].join("");

function careerSitePage(options: {
  readonly title?: string;
  readonly employer?: string | null;
  readonly documentEmployer?: string | null;
  readonly street?: string;
  readonly withMicrodata?: boolean;
}): string {
  const title = options.title ?? "Synthetic Platform Lead";
  const employer = options.employer === undefined ? "Example Group Bank" : options.employer;
  const documentEmployer = options.documentEmployer === undefined ? "Example Group Bank" : options.documentEmployer;
  const scopeOpen = options.withMicrodata === false
    ? '<div class="jobDisplayShell">'
    : '<div class="jobDisplayShell" itemscope="itemscope" itemtype="http://schema.org/JobPosting">'
      + '<span itemprop="jobLocation" itemscope itemtype="http://schema.org/Place">'
      + '<span itemprop="address" itemscope itemtype="http://schema.org/PostalAddress">'
      + `<meta itemprop="streetAddress" content="${options.street ?? "Example City, EC"}"></span></span>`
      + '<meta itemprop="datePosted" content="Sun Oct 25 02:00:00 UTC 2026">'
      + (employer ? `<meta itemprop="hiringOrganization" content="${employer}">` : "");
  const prop = (name: string) => options.withMicrodata === false ? "" : ` itemprop="${name}"`;
  return [
    "<!DOCTYPE html><html><head>",
    `<title>${title} Job Details${documentEmployer ? " | " + documentEmployer : ""}</title>`,
    `<meta property="og:title" content="${title}" />`,
    "</head><body>",
    '<div class="searchwell"><span>Search by Keyword</span></div>',
    scopeOpen,
    '<div class="jobDisplay"><div class="content"><div class="jobTitle">',
    '<a class="btn apply" href="/talentcommunity/apply/4100000001/?locale=en_US">Apply now</a></div>',
    '<div class="job"><div class="row"><div class="col-xs-12">',
    `<h1><span${prop("title")} data-careersite-propertyid="title">${title}\n</span></h1>`,
    "</div></div>",
    '<div class="row"><span class="joblayouttoken-label">Location: </span>',
    '<span data-careersite-propertyid="location"><p class="jobLocation"><span class="jobGeoLocation">Example City</span></p></span></div>',
    `<div class="row"><span${prop("description")} data-careersite-propertyid="description">`,
    `<span class="jobdescription">${description}</span></span></div>`,
    "</div></div></div>",
    "<footer>Careers home | Privacy</footer>",
    "</body></html>",
  ].join("\n");
}

async function fetchPage(html: string, expected: ExpectedPostingIdentity): Promise<JobContentResult> {
  return fetchJobContent(POSTING_URL, expected, {
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchOnce: async (url) => ({
      url: url.toString(),
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: Buffer.from(html, "utf8"),
    }),
  });
}

function complete(result: JobContentResult) {
  if (result.kind !== "COMPLETE") throw new Error("Expected COMPLETE, got " + JSON.stringify(result));
  return result;
}

describe("employer career-site microdata postings", () => {
  it("reads schema.org JobPosting microdata as a structured posting", async () => {
    const result = complete(await fetchPage(careerSitePage({}), { title: "Synthetic Platform Lead", companyName: "Example Group Bank" }));

    expect(result.posting).toMatchObject({
      title: "Synthetic Platform Lead",
      companyName: "Example Group Bank",
      location: "Example City, EC",
      publishedAt: "2026-10-25T02:00:00.000Z",
      requisitionId: "4100000001",
    });
    expect(result.posting.description).toContain("Lead the design and delivery of the synthetic data platform");
    expect(result.posting.description).not.toContain("Search by Keyword");
    expect(result.posting.description).not.toContain("Apply now");
    expect(result.posting.rawPayload).toMatchObject({
      companySource: "EMPLOYER_PAGE_STRUCTURED_DATA",
      employerIdentityCheck: "VERIFIED_AGAINST_DISCOVERY_CARD",
      structuredJobPostingSource: "MICRODATA",
    });
  });

  it("verifies the title only when the card has no employer and records the page as the employer source", async () => {
    for (const companyName of ["", "Unknown Company"]) {
      const result = complete(await fetchPage(careerSitePage({}), { title: "Synthetic Platform Lead - Example City", companyName }));
      expect(result.posting.companyName).toBe("Example Group Bank");
      expect(result.posting.rawPayload).toMatchObject({
        companySource: "EMPLOYER_PAGE_STRUCTURED_DATA",
        employerIdentityCheck: "TITLE_ONLY_EXPECTED_EMPLOYER_UNKNOWN",
      });
    }
  });

  it("falls back to the document title employer when the page has no hiringOrganization", async () => {
    const result = complete(await fetchPage(
      careerSitePage({ employer: null, documentEmployer: "Example Group Bank Ltd." }),
      { title: "Synthetic Platform Lead", companyName: "" },
    ));
    expect(result.posting.companyName).toBe("Example Group Bank Ltd.");
    expect(result.posting.rawPayload).toMatchObject({ companySource: "EMPLOYER_PAGE_TITLE" });
  });

  it("does not invent an employer when neither the card nor the page names one", async () => {
    const result = await fetchPage(
      careerSitePage({ employer: null, documentEmployer: null }),
      { title: "Synthetic Platform Lead", companyName: "" },
    );
    expect(result).toEqual({
      kind: "IDENTITY_CONFLICT",
      reason: "Employer page does not name its employer and the alert card named none.",
    });
  });

  it("keeps the strict employer check when the card names an employer", async () => {
    const result = await fetchPage(careerSitePage({}), { title: "Synthetic Platform Lead", companyName: "Unrelated Insurer" });
    expect(result.kind).toBe("IDENTITY_CONFLICT");
  });

  it("tolerates a trailing location suffix or requisition id on the alert title", async () => {
    const page = careerSitePage({});
    for (const title of [
      "Synthetic Platform Lead - Example City",
      "Synthetic Platform Lead - Example City, EC (EC)",
      "Synthetic Platform Lead (REQ-41001)",
      "Synthetic Platform Lead (REQ-41001) - Example City",
    ]) {
      expect((await fetchPage(page, { title, companyName: "" })).kind, title).toBe("COMPLETE");
    }
  });

  it("still conflicts on a different role or a suffix that is not a location", async () => {
    const page = careerSitePage({});
    for (const title of [
      "Synthetic Platform Engineer - Example City",
      "Synthetic Platform Lead - Payments",
      "Senior Synthetic Platform Lead",
      "Synthetic Platform Lead (Contract)",
    ]) {
      expect((await fetchPage(page, { title, companyName: "" })).kind, title).toBe("IDENTITY_CONFLICT");
    }
  });

  it("uses the page heading when the page has no microdata and tolerates the location suffix there too", async () => {
    const result = complete(await fetchPage(
      careerSitePage({ withMicrodata: false }),
      { title: "Synthetic Platform Lead - Example City", companyName: "" },
    ));
    expect(result.posting).toMatchObject({ title: "Synthetic Platform Lead", companyName: "Example Group Bank", location: "Example City" });
    expect(result.posting.rawPayload).toMatchObject({ companySource: "EMPLOYER_PAGE_TITLE", structuredJobPostingSource: null });
  });

  it("reports a closed posting page as unavailable instead of an identity conflict", async () => {
    const closed = [
      "<html><head><title> Job Details | Example Group Bank</title></head><body>",
      '<div class="jobDisplayShell" itemscope="itemscope"><div class="jobDisplay">',
      "<p class=\"jobErrMsg\"><strong>You can't view this job because it's not available at this time.</strong></p>",
      "</div></div></body></html>",
    ].join("");
    const result = await fetchPage(closed, { title: "Synthetic Platform Lead - Example City", companyName: "" });
    expect(result).toMatchObject({
      kind: "UNAVAILABLE",
      reason: "Employer page shows no posting and states the job is not available.",
    });
  });

  it("blocks an empty page with no posting markup as an unsupported source", async () => {
    const result = await fetchPage(
      "<html><head><title></title></head><body><div id=\"app\"></div></body></html>",
      { title: "Synthetic Platform Lead", companyName: "" },
    );
    expect(result).toEqual({ kind: "BLOCKED", reason: "UNSUPPORTED_SOURCE" });
  });
});
