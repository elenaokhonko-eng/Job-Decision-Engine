import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { parseEnrichLinkedInSavedArguments } from "../../../scripts/enrich_linkedin_saved.js";

import { fetchJobContent, linkedInDetailPublishedAt } from "../../ingestion/jobContentFetcher.js";
import { buildJobSourceEvidence } from "../../ingestion/jobSourceEvidence.js";
import { extractFreshnessEvidence } from "../../ingestion/freshnessEvidence.js";
import {
  LinkedInSavedJobItemSchema,
  linkedInEmploymentTypeRaw,
  parseLinkedInSavedJobItem,
  type LinkedInSavedJob,
} from "../../ingestion/linkedInSavedExport.js";
import { LINKEDIN_POSTING_FACT_FIELDS } from "../../ingestion/linkedInSavedEnrichment.js";
import { savedPostingDerivedObservation } from "../../ingestion/linkedInSavedContent.js";
import { parseMcfSavedJobItem, type McfSavedJob } from "../../ingestion/mcfSavedExport.js";
import {
  parseAbsoluteSourceDate,
  parseRelativePostedText,
  pickPostingFactPayload,
  postingFactsPayload,
} from "../../ingestion/postingFacts.js";
import type { LinkedInJobDetail, SearchApiCallResult } from "../../ingestion/searchApi/searchApiClient.js";
import { evaluateJobFreshness } from "../../policy/stage3PolicyEngine.js";
import { FRESHNESS_BASIS_PATTERN, parseFreshnessBasis } from "../../contracts/postingFacts.js";
import {
  GUEST_PAGE_CLOSED,
  GUEST_PAGE_NO_SIGNALS,
  GUEST_PAGE_OPEN_CLOSED_SIMILAR_JOB,
  GUEST_PAGE_OPEN_PHRASE_IN_DESCRIPTION,
  GUEST_PAGE_OPEN_ABSOLUTE,
  GUEST_PAGE_OPEN_RELATIVE,
} from "../fixtures/linkedInGuestPostingPages.js";

const CHECKED_AT = "2026-11-10T08:00:00.000Z";
const IMPORTED_AT = "2026-11-10T09:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const DESCRIPTION = [
  "About the role: Example Synthetic Analytics is hiring a data engineer for its synthetic platform team.",
  "Responsibilities: you will design data models, build reporting pipelines and coordinate delivery with product squads.",
  "Requirements: experience with SQL, Python, cloud warehouses and clear written communication with stakeholders.",
].join("\n");

function linkedInItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Synthetic Data Engineer",
    company: "Example Synthetic Analytics",
    url: "https://www.linkedin.com/jobs/view/4300000101/",
    description: DESCRIPTION,
    descriptionStatus: "OK",
    location: "Singapore (Hybrid)",
    linkedinJobId: "4300000101",
    exportedAt: CHECKED_AT,
    sourcePage: "https://www.linkedin.com/jobs-tracker/",
    ...overrides,
  };
}

function parsedLinkedIn(overrides: Record<string, unknown> = {}): LinkedInSavedJob {
  const job = parseLinkedInSavedJobItem(linkedInItem(overrides), 0);
  if (typeof job === "string") throw new Error(job);
  return job;
}

function evidenceFor(job: { rawPayload: Record<string, unknown>; title: string; description: string }, sourceName = "LINKEDIN_SAVED", retrievedAt = IMPORTED_AT) {
  return buildJobSourceEvidence({
    sourceName,
    sourcePluginKey: sourceName.toLowerCase(),
    sourcePluginRevisionId: null,
    sourceExternalId: "linkedin-job:4300000101",
    sourceUrl: "https://www.linkedin.com/jobs/view/4300000101",
    canonicalApplyUrl: "https://www.linkedin.com/jobs/view/4300000101",
    retrievedAt,
    rawPayloadHash: createHash("sha256").update(JSON.stringify(job.rawPayload)).digest("hex"),
    rawPayload: job.rawPayload,
    companyName: "Example Synthetic Analytics",
    title: job.title,
    locationRaw: null,
    workplaceTypeRaw: null,
    employmentTypeRaw: null,
    compensationRaw: null,
    descriptionText: job.description,
  });
}

/** postingFactsFromHtml and its helpers, taken from the browser snippet itself. */
interface SnippetFunctions {
  readonly postingFactsFromHtml: (html: string) => Record<string, unknown>;
  readonly htmlText: (html: string) => string;
  readonly needsFetch: (job: Record<string, unknown>, state: Record<string, unknown>) => boolean;
  readonly recordFailedRead: (job: Record<string, unknown>, reason: string) => void;
}

function snippetFunctions(): SnippetFunctions {
  const source = fs.readFileSync(path.resolve(process.cwd(), "scripts", "linkedin", "export_saved_jobs.console.js"), "utf8");
  const block = source.match(/ {2}const decodeEntities[\s\S]*?\n {2}function recordFailedRead\(job, reason\) \{[\s\S]*?\r?\n {2}\}\r?\n/)?.[0];
  if (!block) throw new Error("The posting-fact functions were not found in the snippet.");
  const clean = (value: string) => (value || "").replace(/\s+/g, " ").trim();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- evaluates the repository's own snippet source
  return new Function("clean", `${block}; return { postingFactsFromHtml, htmlText, needsFetch, recordFailedRead };`)(clean) as SnippetFunctions;
}

function snippetPostingFacts(): (html: string) => Record<string, unknown> {
  return snippetFunctions().postingFactsFromHtml;
}

/** Median of three runs, as in the email-extractor complexity checks. */
function medianMs(run: () => unknown): number {
  const samples: number[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return samples.sort((left, right) => left - right)[1] as number;
}

/** Linear growth is ~4x for 4x the input; a quadratic scan needs ~16x. */
function expectLinear(build: (size: number) => () => unknown, size: number): void {
  build(size / 16)();
  const small = medianMs(build(size / 4));
  const large = medianMs(build(size));
  expect(large).toBeLessThan(2_000);
  expect(large / Math.max(small, 5)).toBeLessThan(10);
}

describe("relative and absolute posting dates", () => {
  it("converts relative age text against the time it was read and records its precision", () => {
    const anchor = new Date(CHECKED_AT).getTime();
    const cases: Array<[string, number, string, "POSTED" | "REPOSTED"]> = [
      ["2 weeks ago", 14 * DAY, "WEEK", "POSTED"],
      ["Reposted 3 days ago", 3 * DAY, "DAY", "REPOSTED"],
      ["Posted 2w ago", 14 * DAY, "WEEK", "POSTED"],
      ["1 month ago", 30 * DAY, "MONTH", "POSTED"],
      ["an hour ago", 60 * 60 * 1000, "HOUR", "POSTED"],
      ["5 mins ago", 5 * 60 * 1000, "MINUTE", "POSTED"],
      ["yesterday", DAY, "DAY", "POSTED"],
    ];
    for (const [text, ageMs, precision, kind] of cases) {
      const parsed = parseRelativePostedText(text, CHECKED_AT);
      expect(parsed, text).not.toBeNull();
      expect(parsed?.iso, text).toBe(new Date(anchor - ageMs).toISOString());
      expect(parsed?.kind, text).toBe(kind);
      expect(parsed?.derivation, text).toEqual({ basis: "RELATIVE_SOURCE_TEXT", precision, source_text: text, anchor_at: CHECKED_AT });
    }
  });

  it("never invents a date from lower-bound, unreadable or unanchored text", () => {
    expect(parseRelativePostedText("30+ days ago", CHECKED_AT)).toBeNull();
    expect(parseRelativePostedText("Be an early applicant", CHECKED_AT)).toBeNull();
    expect(parseRelativePostedText("in 2 days", CHECKED_AT)).toBeNull();
    expect(parseRelativePostedText("2 weeks ago", null)).toBeNull();
    expect(parseRelativePostedText("2 weeks ago", "last Tuesday")).toBeNull();
    expect(parseAbsoluteSourceDate("2 weeks ago")).toBeNull();
    expect(parseAbsoluteSourceDate("2026-10-28")).toEqual({ iso: "2026-10-28T00:00:00.000Z", precision: "DAY", sourceText: "2026-10-28" });
    expect(parseAbsoluteSourceDate("2026-10-28T09:12:00.000Z")?.precision).toBe("EXACT");
  });

  it("keeps a status unknown without a check time and ignores dates later than the check", () => {
    const noCheck = postingFactsPayload({ availabilityStatus: "OPEN", checkMethod: "TEST", notAfter: IMPORTED_AT });
    expect(noCheck.availability).toBe("UNKNOWN");
    expect(noCheck.payload).toEqual({});
    expect(noCheck.ignored).toContain("availabilityStatus has no valid check time");

    const future = postingFactsPayload({ postedAt: "2026-12-01", checkMethod: "TEST", checkedAt: CHECKED_AT, notAfter: IMPORTED_AT });
    expect(future.publishedAt).toBeNull();
    expect(future.ignored).toContain("postedAt is later than the check time");

    const both = postingFactsPayload({ postedAt: "2026-10-28", postedAtText: "2 weeks ago", checkMethod: "TEST", checkedAt: CHECKED_AT, notAfter: IMPORTED_AT });
    expect(both.publishedAt).toBe("2026-10-28T00:00:00.000Z");
    expect(both.payload.date_derivations).toEqual({ posted_at: { basis: "ABSOLUTE_SOURCE_DATE", precision: "DAY", source_text: "2026-10-28", anchor_at: null } });
  });
});

describe("LinkedIn guest posting page (export snippet)", () => {
  const facts = snippetPostingFacts();

  it("reads JSON-LD dates, the age text and an open apply button, not other jobs' dates", () => {
    expect(facts(GUEST_PAGE_OPEN_ABSOLUTE)).toEqual({
      postedAt: "2026-10-28T09:12:00.000Z",
      postedAtText: "2 weeks ago",
      validThrough: "2026-12-27T09:12:00.000Z",
      availabilityStatus: "OPEN",
      availabilityEvidence: "Apply button shown; no \"No longer accepting applications\" banner",
      employmentType: "FULL_TIME",
    });
  });

  it("reads relative text only when no absolute date is on the page", () => {
    expect(facts(GUEST_PAGE_OPEN_RELATIVE)).toMatchObject({ postedAt: null, postedAtText: "Reposted 3 days ago", validThrough: null, availabilityStatus: "OPEN" });
  });

  it("reads the posting's own Employment type row, not a similar job's", () => {
    expect(facts(GUEST_PAGE_OPEN_RELATIVE).employmentType).toBe("Full-time");
    expect(facts(GUEST_PAGE_CLOSED).employmentType).toBe("Contract");
    // GUEST_PAGE_NO_SIGNALS has no criteria list of its own; the similar job's "Internship" is ignored.
    expect(facts(GUEST_PAGE_NO_SIGNALS).employmentType).toBeNull();
  });

  it("reads the closed banner as CLOSED with its text", () => {
    expect(facts(GUEST_PAGE_CLOSED)).toMatchObject({
      postedAtText: "1 month ago",
      availabilityStatus: "CLOSED",
      availabilityEvidence: "No longer accepting applications",
    });
  });

  it("leaves everything unknown when the page shows none of the signals", () => {
    expect(facts(GUEST_PAGE_NO_SIGNALS)).toEqual({
      postedAt: null,
      postedAtText: null,
      validThrough: null,
      availabilityStatus: "UNKNOWN",
      availabilityEvidence: null,
      employmentType: null,
    });
  });

  it("emits the posting-fact fields for every saved job and records when the page was read", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "scripts", "linkedin", "export_saved_jobs.console.js"), "utf8");
    expect(source).toMatch(/Object\.assign\(job, postingFactsFromHtml\(html\), \{ postingCheckedAt: readAt, postingRecheckFailedAt: null, postingRecheckFailure: null \}\)/);
    expect(source).toMatch(/recordFailedRead\(job, `HTTP \$\{response\.status\}`\)/);
    expect(source).toMatch(/window\.jdeLinkedInExport = \{ resume, refresh,/);
    // refresh() keeps earlier facts and their check times; it only requests a re-read.
    expect(source).not.toMatch(/postingCheckedAt = null/);
  });

  it("never reads the closed phrase from the description or another job's card", () => {
    expect(facts(GUEST_PAGE_OPEN_PHRASE_IN_DESCRIPTION)).toMatchObject({ availabilityStatus: "OPEN", postedAtText: "5 days ago" });
    expect(facts(GUEST_PAGE_OPEN_CLOSED_SIMILAR_JOB)).toMatchObject({ availabilityStatus: "OPEN", postedAtText: "5 days ago" });
    // Without the posting's own top card nothing is read, even if other parts carry signals.
    expect(facts(`<div class="description__text">No longer accepting applications</div><span class="posted-time-ago__text">1 day ago</span>`))
      .toMatchObject({ availabilityStatus: "UNKNOWN", postedAtText: null });
  });

  it("keeps earlier facts and their check time when a refresh() re-read fails", () => {
    const { needsFetch, recordFailedRead } = snippetFunctions();
    const read = {
      descriptionStatus: "OK",
      description: DESCRIPTION,
      postedAtText: "2 weeks ago",
      availabilityStatus: "OPEN",
      postingCheckedAt: "2026-11-01T08:00:00.000Z",
      postingRecheckFailedAt: null,
      postingRecheckFailure: null,
    };
    const state = { refreshRequestedAt: "2026-11-10T08:00:00.000Z" };
    expect(needsFetch(read, {})).toBe(false);
    expect(needsFetch(read, state)).toBe(true);
    const job: Record<string, unknown> = { ...read };
    recordFailedRead(job, "HTTP 404");
    expect(job).toMatchObject({
      descriptionStatus: "OK",
      description: DESCRIPTION,
      postedAtText: "2 weeks ago",
      availabilityStatus: "OPEN",
      postingCheckedAt: "2026-11-01T08:00:00.000Z",
      postingRecheckFailure: "HTTP 404",
    });
    // The failed attempt is not retried within the same refresh.
    expect(needsFetch(job, state)).toBe(false);

    // Imported, the facts stay anchored to the earlier read and the item stays valid.
    const imported = parsedLinkedIn({ ...job, exportedAt: "2026-11-10T08:05:00.000Z" });
    expect(imported.rawPayload.posted_at).toBe(new Date(new Date("2026-11-01T08:00:00.000Z").getTime() - 14 * DAY).toISOString());
    expect(imported.rawPayload.availability_checked_at).toBe("2026-11-01T08:00:00.000Z");
    expect(imported.rawPayload.exported_item).toMatchObject({ postingRecheckFailure: "HTTP 404" });
  });

  it("htmlText and postingFactsFromHtml stay linear on hostile markup", () => {
    const { htmlText, postingFactsFromHtml } = snippetFunctions();
    expectLinear((size) => {
      const html = "<".repeat(size);
      return () => htmlText(html);
    }, 160_000);
    expectLinear((size) => {
      const html = `<section class="top-card-layout">${"<span class=\"posted-time-ago__text".repeat(Math.floor(size / 36))}`;
      return () => postingFactsFromHtml(html);
    }, 400_000);
    expectLinear((size) => {
      const html = `${"<script type=\"application/ld+json\">{".repeat(Math.floor(size / 37))}<section class="top-card-layout"><div class="closed-job ${"x".repeat(size)}`;
      return () => postingFactsFromHtml(html);
    }, 400_000);
    expectLinear((size) => {
      const html = `<ul class="description__job-criteria-list">${"<h3 class=\"description__job-criteria-subheader\">Seniority".repeat(Math.floor(size / 60))}`;
      return () => postingFactsFromHtml(html);
    }, 400_000);
  });
});

describe("LinkedIn saved export employment type", () => {
  it("maps the posting's label to an employment_type_raw and keeps unknown labels unknown", () => {
    const cases: Array<[string | null, string]> = [
      ["Full-time", "FULL_TIME"],
      ["FULL_TIME", "FULL_TIME"],
      ["Contract", "CONTRACT"],
      ["CONTRACTOR", "CONTRACT"],
      ["Part-time", "PART_TIME"],
      ["Temporary", "TEMPORARY"],
      ["Internship", "INTERNSHIP"],
      ["Other", "UNKNOWN"],
      ["Volunteer", "UNKNOWN"],
      ["FULL_TIME, CONTRACTOR", "UNKNOWN"],
      [null, "UNKNOWN"],
    ];
    for (const [label, raw] of cases) {
      expect(linkedInEmploymentTypeRaw(label), String(label)).toBe(raw);
    }
  });

  it("records the label in the payload and the job only when the export has it", () => {
    const labelled = parsedLinkedIn({ employmentType: "Full-time", postingCheckedAt: CHECKED_AT });
    expect(labelled.employmentType).toBe("FULL_TIME");
    expect(labelled.rawPayload.exported_item).toMatchObject({ employmentType: "Full-time" });

    const older = parsedLinkedIn();
    expect(older.employmentType).toBe("UNKNOWN");
    expect(older.rawPayload.exported_item).not.toHaveProperty("employmentType");
  });

  it("lets a refresh() enrichment carry the label to jobs already imported", () => {
    expect(LINKEDIN_POSTING_FACT_FIELDS).toContain("employmentType");
  });
});

describe("LinkedIn saved export posting facts", () => {
  it("keeps an older export's payload (and so its hash) unchanged", () => {
    const job = parsedLinkedIn();
    expect(Object.keys(job.rawPayload)).toEqual(["export_schema", "content_provenance", "linkedin_job_id", "canonical_url", "legacy_export_shape", "import_notes", "exported_item"]);
    expect(Object.keys(job.rawPayload.exported_item as object)).toEqual(["title", "company", "url", "description", "descriptionStatus", "location", "salary", "postedAt", "linkedinJobId", "sourcePage"]);
    const evidence = evidenceFor(job);
    expect(evidence.availability.status).toBe("UNKNOWN");
    expect(evidence.dates.published_at.status).toBe("UNKNOWN");
  });

  it("turns an open guest page with relative age text into a dated, verified-open observation", () => {
    const job = parsedLinkedIn({ postedAtText: "2 weeks ago", availabilityStatus: "OPEN", availabilityEvidence: "Apply button shown", postingCheckedAt: CHECKED_AT });
    const published = new Date(new Date(CHECKED_AT).getTime() - 14 * DAY).toISOString();
    expect(job.rawPayload).toMatchObject({
      posted_at: published,
      status: "open",
      availability_checked_at: CHECKED_AT,
      availability_check_method: "LINKEDIN_GUEST_POSTING_PAGE_USER_BROWSER",
      availability_evidence_text: "Apply button shown",
      date_derivations: { posted_at: { basis: "RELATIVE_SOURCE_TEXT", precision: "WEEK", source_text: "2 weeks ago", anchor_at: CHECKED_AT } },
      posting_facts_schema: "posting_facts_v1",
    });
    expect(extractFreshnessEvidence({ rawPayload: job.rawPayload, sourceName: "LINKEDIN_SAVED", sourceExternalId: "linkedin-job:4300000101", canonicalUrl: job.canonicalUrl, contentHash: "x" }).sourcePublishedAt).toBe(published);

    const evidence = evidenceFor(job);
    expect(evidence.dates.published_at).toMatchObject({ status: "SUPPORTED", value: published, basis: "PUBLISHED_AT" });
    expect(evidence.dates.published_at.evidence[0]).toMatchObject({ confidence: "LOW" });
    expect(evidence.dates.published_at.evidence[0]?.quote_text).toContain("derived from source text \"2 weeks ago\"");
    expect(evidence.dates.published_at.evidence[0]?.quote_text).toContain("precision WEEK");
    // Verified as of the page read (not the import), with the one-day explicit-status window.
    expect(evidence.availability).toMatchObject({
      status: "OPEN",
      verified_at: CHECKED_AT,
      expires_at: new Date(new Date(CHECKED_AT).getTime() + 7 * DAY).toISOString(),
      verification_method: "EXPLICIT_SOURCE_STATUS",
      reason_code: "CURRENT_LISTING_EVIDENCE",
    });
    expect(evidence.availability.evidence[0]?.quote_text).toContain(`read via LINKEDIN_GUEST_POSTING_PAGE_USER_BROWSER at ${CHECKED_AT}: "Apply button shown"`);
  });

  it("records an absolute date and deadline from JSON-LD, and a closed banner as CLOSED", () => {
    const job = parsedLinkedIn({
      postedAt: "2026-10-28T09:12:00.000Z",
      postedAtText: "2 weeks ago",
      validThrough: "2026-12-27T09:12:00.000Z",
      availabilityStatus: "CLOSED",
      availabilityEvidence: "No longer accepting applications",
      postingCheckedAt: CHECKED_AT,
    });
    const evidence = evidenceFor(job);
    expect(evidence.dates.published_at).toMatchObject({ status: "SUPPORTED", value: "2026-10-28T09:12:00.000Z" });
    expect(evidence.dates.published_at.evidence[0]?.confidence).toBe("MEDIUM");
    expect(evidence.dates.expires_at).toMatchObject({ status: "SUPPORTED", value: "2026-12-27T09:12:00.000Z", basis: "EXPIRES_AT" });
    expect(evidence.availability).toMatchObject({ status: "CLOSED", verified_at: CHECKED_AT, reason_code: "SOURCE_EXPLICITLY_CLOSED" });
  });

  it("maps a LinkedIn repost label to the repost date, never to the publication date", () => {
    const job = parsedLinkedIn({ postedAtText: "Reposted 3 days ago", postingCheckedAt: CHECKED_AT });
    expect(job.rawPayload.posted_at).toBeUndefined();
    expect(job.rawPayload.reposted_at).toBe(new Date(new Date(CHECKED_AT).getTime() - 3 * DAY).toISOString());
    const evidence = evidenceFor(job);
    expect(evidence.dates.published_at.status).toBe("UNKNOWN");
    expect(evidence.dates.reposted_at).toMatchObject({ status: "SUPPORTED", basis: "GENUINE_REPOST_AT" });
  });

  it("rejects a status without its check time and keeps unknown status unknown", () => {
    expect(parseLinkedInSavedJobItem(linkedInItem({ availabilityStatus: "OPEN" }), 0)).toMatch(/needs postingCheckedAt/);
    const unknown = parsedLinkedIn({ availabilityStatus: "UNKNOWN", postingCheckedAt: CHECKED_AT });
    expect(unknown.rawPayload.status).toBeUndefined();
    expect(evidenceFor(unknown).availability.status).toBe("UNKNOWN");
    expect(LinkedInSavedJobItemSchema.safeParse(linkedInItem({ availabilityStatus: "MAYBE" })).success).toBe(false);
  });

  it("does not verify a status whose check time is after the import", () => {
    const job = parsedLinkedIn({ availabilityStatus: "OPEN", postingCheckedAt: "2026-11-12T00:00:00.000Z" });
    expect(evidenceFor(job, "LINKEDIN_SAVED", IMPORTED_AT).availability.status).toBe("UNKNOWN");
  });

  it("carries the export's posting facts to the observation derived for a Gmail card", () => {
    const job = parsedLinkedIn({ postedAtText: "2 weeks ago", availabilityStatus: "OPEN", postingCheckedAt: CHECKED_AT });
    const derived = savedPostingDerivedObservation("00000000-0000-4000-8000-000000000001", {
      observationId: "00000000-0000-4000-8000-000000000002",
      linkedInJobId: job.linkedInJobId,
      canonicalUrl: job.canonicalUrl,
      title: job.title,
      companyName: job.company,
      description: job.description,
      location: null,
      compensation: null,
      postedAt: null,
      postingFacts: pickPostingFactPayload(job.rawPayload),
      importedAt: IMPORTED_AT,
      exportPayloadHash: "a".repeat(64),
    });
    expect(derived.rawPayload).toMatchObject({ posted_at: job.rawPayload.posted_at, status: "open", availability_checked_at: CHECKED_AT });
    expect(pickPostingFactPayload({ status: "open" })).toEqual({});
  });
});

describe("SearchAPI linkedin_job_details posted_at", () => {
  const NOW = new Date("2026-11-07T05:30:00.000Z");
  const JOB_ID = "4000000001";
  const EVIDENCE = {
    requestUrl: `https://www.searchapi.io/api/v1/search?engine=linkedin_job_details&job_id=${JOB_ID}`,
    httpStatus: 200,
    retrievedAt: NOW.toISOString(),
    responseHash: "b".repeat(64),
    ledgerRequestId: "ledger-1",
  };
  // Synthetic response in the provider's documented shape ({ job: {...} }); no recorded call.
  function detail(postedAt: string | undefined): SearchApiCallResult<LinkedInJobDetail> {
    const job = {
      job_id: JOB_ID,
      title: "Synthetic Data Architect",
      company_name: "Example Analytics",
      location: "Singapore (Hybrid)",
      description: DESCRIPTION,
      ...(postedAt === undefined ? {} : { posted_at: postedAt }),
    } as LinkedInJobDetail;
    return { kind: "OK", data: job, raw: { job }, evidence: EVIDENCE };
  }

  it("converts the relative posted_at against the response time with its precision", async () => {
    const result = await fetchJobContent(`https://www.linkedin.com/jobs/view/${JOB_ID}/`, { title: "Synthetic Data Architect", companyName: "Example Analytics" }, {
      linkedInJobDetails: vi.fn(async () => detail("1 week ago")),
      fetchOnce: vi.fn(),
      now: () => NOW,
    });
    expect(result.kind).toBe("COMPLETE");
    if (result.kind !== "COMPLETE") return;
    const published = new Date(NOW.getTime() - 7 * DAY).toISOString();
    expect(result.posting.publishedAt).toBe(published);
    expect(result.posting.date_derivations).toEqual({ publishedAt: { basis: "RELATIVE_SOURCE_TEXT", precision: "WEEK", source_text: "1 week ago", anchor_at: NOW.toISOString() } });
    // The worker stores the posting under `posting`; the evidence builder reads it from there.
    const evidence = evidenceFor({ rawPayload: { source_content_status: "COMPLETE", posting: result.posting }, title: result.posting.title, description: DESCRIPTION }, "LINKEDIN", NOW.toISOString());
    expect(evidence.dates.published_at).toMatchObject({ status: "SUPPORTED", value: published });
    expect(evidence.dates.published_at.evidence[0]?.quote_text).toContain("derived from source text \"1 week ago\"");
  });

  it("keeps the date unknown for a repost label, a missing value or unreadable text", () => {
    expect(linkedInDetailPublishedAt("Reposted 2 days ago", NOW.toISOString())).toBeNull();
    expect(linkedInDetailPublishedAt(undefined, NOW.toISOString())).toBeNull();
    expect(linkedInDetailPublishedAt("30+ days ago", NOW.toISOString())).toBeNull();
    expect(linkedInDetailPublishedAt("2026-11-01", NOW.toISOString())?.derivation.basis).toBe("ABSOLUTE_SOURCE_DATE");
  });
});

describe("MyCareersFuture saved export posting facts", () => {
  const UUID = "0123456789abcdef0123456789abcdef";
  function mcfItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      title: "Synthetic Data Engineer",
      company: "EXAMPLE SYNTHETIC ANALYTICS PTE. LTD.",
      url: `https://www.mycareersfuture.gov.sg/job/information-technology/synthetic-data-engineer-${UUID}`,
      description: DESCRIPTION,
      descriptionStatus: "OK",
      location: null,
      salary: null,
      employmentType: "Permanent",
      postedAt: "2026-11-01",
      expiresAt: "2026-12-01",
      mcfJobUuid: UUID,
      exportedAt: CHECKED_AT,
      sourcePage: "https://www.mycareersfuture.gov.sg/saved-jobs",
      ...overrides,
    };
  }
  function parsedMcf(overrides: Record<string, unknown> = {}): McfSavedJob {
    const job = parseMcfSavedJobItem(mcfItem(overrides), 0);
    if (typeof job === "string") throw new Error(job);
    return job;
  }

  it("persists an older export's posted and expiry dates as root facts the evidence builder reads", () => {
    const job = parsedMcf();
    expect(job.rawPayload).toMatchObject({ posted_at: "2026-11-01T00:00:00.000Z", source_expires_at: "2026-12-01T00:00:00.000Z" });
    expect(job.rawPayload.status).toBeUndefined();
    const evidence = evidenceFor(job, "MCF_SAVED");
    expect(evidence.dates.published_at).toMatchObject({ status: "SUPPORTED", value: "2026-11-01T00:00:00.000Z" });
    expect(evidence.dates.expires_at).toMatchObject({ status: "SUPPORTED", value: "2026-12-01T00:00:00.000Z" });
    expect(evidence.availability.status).toBe("UNKNOWN");
  });

  it("separates the original posting date from a repost and verifies MCF's job status at its check time", () => {
    const job = parsedMcf({ originalPostedAt: "2026-10-01", availabilityStatus: "OPEN", availabilityEvidence: "MyCareersFuture job status: Open", postingCheckedAt: CHECKED_AT });
    expect(job.rawPayload).toMatchObject({ posted_at: "2026-10-01T00:00:00.000Z", reposted_at: "2026-11-01T00:00:00.000Z", status: "open" });
    const evidence = evidenceFor(job, "MCF_SAVED");
    expect(evidence.availability).toMatchObject({ status: "OPEN", verified_at: CHECKED_AT, verification_method: "EXPLICIT_SOURCE_STATUS" });
    expect(evidence.dates.reposted_at).toMatchObject({ status: "SUPPORTED", value: "2026-11-01T00:00:00.000Z" });

    const closed = parsedMcf({ availabilityStatus: "CLOSED", postingCheckedAt: CHECKED_AT });
    expect(evidenceFor(closed, "MCF_SAVED").availability.status).toBe("CLOSED");
    expect(parseMcfSavedJobItem(mcfItem({ availabilityStatus: "OPEN" }), 0)).toMatch(/needs postingCheckedAt/);
  });
});

describe("approximate dates downstream", () => {
  const AS_OF = new Date("2026-11-10T08:00:00.000Z");
  const freshness = (text: string, limit: number) => {
    const derived = parseRelativePostedText(text, AS_OF.toISOString());
    if (!derived) throw new Error(text);
    const basis = extractFreshnessEvidence({
      rawPayload: { posted_at: derived.iso, date_derivations: { posted_at: derived.derivation } },
      sourceName: "LINKEDIN_SAVED",
      sourceExternalId: null,
      canonicalUrl: null,
      contentHash: "x",
    });
    return { basis, result: evaluateJobFreshness({ posted_at: derived.iso, freshness_basis: basis.freshnessBasis }, { max_posting_age_days: limit, stale_gate_disposition: "HARD_REJECT" } as never, AS_OF) };
  };

  it("marks relative-text dates approximate with lower confidence, not authoritative", () => {
    const { basis, result } = freshness("2 weeks ago", 60);
    expect(basis).toMatchObject({ freshnessBasis: "POSTED_AT_APPROXIMATE_WEEK", approximateUnit: "WEEK", freshnessConfidence: 50 });
    expect(result).toMatchObject({ status: "AGING", freshness_basis: "POSTED_AT_APPROXIMATE", freshness_confidence: "LOW", job_age_days: 20 });
    expect(result.evidence).toMatch(/^Approximate posting age of 14-20 days/);
    expect(result.evidence).not.toMatch(/Authoritative/);
    // An absolute date keeps the authoritative basis.
    expect(evaluateJobFreshness({ posted_at: "2026-10-27T08:00:00.000Z", freshness_basis: "POSTED_AT" }, { max_posting_age_days: 60 } as never, AS_OF))
      .toMatchObject({ freshness_basis: "POSTED_AT", freshness_confidence: "HIGH" });
  });

  it("is within the limit only when the oldest possible date is, and stale only when the newest is past it", () => {
    // "4 weeks ago" means 28-34 days.
    expect(freshness("4 weeks ago", 30).result).toMatchObject({ status: "UNKNOWN", is_hard_reject: false });
    expect(freshness("4 weeks ago", 33).result.status).toBe("UNKNOWN");
    expect(freshness("4 weeks ago", 34).result).toMatchObject({ status: "AGING", job_age_days: 34 });
    expect(freshness("3 weeks ago", 30).result).toMatchObject({ status: "AGING", job_age_days: 27 });
    expect(freshness("5 weeks ago", 30).result).toMatchObject({ status: "STALE", is_hard_reject: true, rejection_code: "GATE_STALE_POSTING" });
    expect(freshness("4 weeks ago", 27).result).toMatchObject({ status: "STALE", job_age_days: 28 });
    // "1 month ago" means 30-59 days: never within a 30-day limit, unknown against 45, within 60.
    expect(freshness("1 month ago", 45).result.status).toBe("UNKNOWN");
    expect(freshness("1 month ago", 60).result).toMatchObject({ status: "AGING", job_age_days: 59 });
    expect(freshness("2 months ago", 59).result.status).toBe("STALE");
  });

  it("parses freshness_basis fail-safe: an unrecognized value is never an authoritative date", () => {
    for (const basis of ["POSTED_AT", "REPOSTED_AT", "NEW_POSTING_ID", "NO_DATE", "UNKNOWN", ...["MINUTE", "HOUR", "DAY", "WEEK", "MONTH", "YEAR"].flatMap((unit) => [`POSTED_AT_APPROXIMATE_${unit}`, `REPOSTED_AT_APPROXIMATE_${unit}`])]) {
      expect(FRESHNESS_BASIS_PATTERN.test(basis), basis).toBe(true);
      expect(parseFreshnessBasis(basis).kind, basis).not.toBe("UNRECOGNIZED");
    }
    for (const basis of ["POSTED_AT_APPROXIMATE_FORTNIGHT", "POSTED_AT_APPROXIMATE", "posted_at", "AUTHORITATIVE"]) {
      expect(parseFreshnessBasis(basis), basis).toEqual({ kind: "UNRECOGNIZED", approximateUnit: null });
      expect(evaluateJobFreshness({ posted_at: "2026-11-01T00:00:00.000Z", freshness_basis: basis }, { max_posting_age_days: 30 } as never, AS_OF), basis)
        .toMatchObject({ status: "UNKNOWN", freshness_confidence: "LOW", is_hard_reject: false });
    }
  });

  it("reads an estimate from its evidence whatever the identity basis says", () => {
    const derived = parseRelativePostedText("4 weeks ago", AS_OF.toISOString());
    const result = evaluateJobFreshness({ posted_at: derived?.iso, freshness_basis: "NEW_POSTING_ID", approximate_unit: "WEEK" }, { max_posting_age_days: 30 } as never, AS_OF);
    expect(result).toMatchObject({ status: "UNKNOWN", freshness_basis: "POSTED_AT_APPROXIMATE", freshness_confidence: "LOW" });
    expect(result.evidence).not.toMatch(/Authoritative/);
  });

  it("does not hard-reject on month or year precision, whose rounding is unconfirmed", () => {
    expect(freshness("2 months ago", 45).result).toMatchObject({ status: "STALE", is_hard_reject: false });
    expect(freshness("9 weeks ago", 60).result).toMatchObject({ status: "STALE", is_hard_reject: true });
  });

  it("carries both bounds in the source evidence and treats a future date as unknown age", () => {
    const job = parsedLinkedIn({ postedAtText: "4 weeks ago", postingCheckedAt: CHECKED_AT });
    const evidence = evidenceFor(job);
    expect(evidence.dates.published_at.approximation).toEqual({
      basis: "RELATIVE_SOURCE_TEXT",
      precision: "WEEK",
      earliest_value: new Date(new Date(CHECKED_AT).getTime() - 35 * DAY + 1).toISOString(),
      source_text: "4 weeks ago",
      anchor_at: CHECKED_AT,
    });
    expect(evidenceFor(parsedLinkedIn({ postedAt: "2026-10-28", postingCheckedAt: CHECKED_AT })).dates.published_at.approximation).toBeUndefined();
    expect(evaluateJobFreshness({ posted_at: "2026-11-20T00:00:00.000Z", freshness_basis: "POSTED_AT" }, { max_posting_age_days: 60 } as never, AS_OF))
      .toMatchObject({ status: "UNKNOWN", job_age_days: null });
  });

  it("derives no date or status from a check time later than the import", () => {
    const future = new Date(Date.now() + 10 * DAY).toISOString();
    const job = parsedLinkedIn({ postedAtText: "1 day ago", availabilityStatus: "OPEN", postingCheckedAt: future });
    expect(job.rawPayload.posted_at).toBeUndefined();
    expect(job.rawPayload.status).toBeUndefined();
    expect(job.postingFacts.ignored).toContain("checkedAt is later than the import time");
    // Relative text is never re-anchored to exportedAt.
    const unanchored = parsedLinkedIn({ postedAtText: "2 weeks ago", postingCheckedAt: null, exportedAt: new Date().toISOString() });
    expect(unanchored.rawPayload.posted_at).toBeUndefined();
  });

  it("quarantines malformed or future-anchored posting facts instead of reading them in part", () => {
    const base = parsedLinkedIn({ postedAtText: "2 weeks ago", postingCheckedAt: CHECKED_AT });
    const malformed = { ...base, rawPayload: { ...base.rawPayload, date_derivations: { posted_at: { basis: "RELATIVE_SOURCE_TEXT", precision: "WEEK", source_text: "2 weeks ago", anchor_at: null } } } };
    expect(() => evidenceFor(malformed)).toThrow(/Posting facts do not match posting_facts_v1|Date derivations are malformed/);
    const statusOnly = { ...base, rawPayload: { ...base.rawPayload, status: "open" } };
    expect(() => evidenceFor(statusOnly)).toThrow(/availability_checked_at/);
    const futureAnchor = { ...base, rawPayload: { ...base.rawPayload, date_derivations: { posted_at: { basis: "RELATIVE_SOURCE_TEXT", precision: "WEEK", source_text: "2 weeks ago", anchor_at: "2026-11-20T00:00:00.000Z" } } } };
    expect(() => evidenceFor(futureAnchor, "LINKEDIN_SAVED", IMPORTED_AT)).toThrow(/anchored after the observation was retrieved/);
  });
});

describe("enrich:linkedin-saved command line", () => {
  it("is a dry run unless --apply is given", () => {
    expect(parseEnrichLinkedInSavedArguments(["export.json"])).toEqual({ filePath: "export.json", apply: false });
    expect(parseEnrichLinkedInSavedArguments(["export.json", "--apply"])).toEqual({ filePath: "export.json", apply: true });
    expect(parseEnrichLinkedInSavedArguments(["export.json", "--apply", "--dry-run"])).toEqual({ filePath: "export.json", apply: false });
    expect(() => parseEnrichLinkedInSavedArguments([])).toThrow(/Usage/);
    expect(() => parseEnrichLinkedInSavedArguments(["export.json", "--force"])).toThrow(/Unsupported argument/);
  });
});
