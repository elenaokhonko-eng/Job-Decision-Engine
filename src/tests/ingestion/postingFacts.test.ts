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
  parseLinkedInSavedJobItem,
  type LinkedInSavedJob,
} from "../../ingestion/linkedInSavedExport.js";
import { savedPostingDerivedObservation } from "../../ingestion/linkedInSavedContent.js";
import { parseMcfSavedJobItem, type McfSavedJob } from "../../ingestion/mcfSavedExport.js";
import {
  parseAbsoluteSourceDate,
  parseRelativePostedText,
  pickPostingFactPayload,
  postingFactsPayload,
} from "../../ingestion/postingFacts.js";
import type { LinkedInJobDetail, SearchApiCallResult } from "../../ingestion/searchApi/searchApiClient.js";
import {
  GUEST_PAGE_CLOSED,
  GUEST_PAGE_NO_SIGNALS,
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
function snippetPostingFacts(): (html: string) => Record<string, unknown> {
  const source = fs.readFileSync(path.resolve(process.cwd(), "scripts", "linkedin", "export_saved_jobs.console.js"), "utf8");
  const block = source.match(/ {2}const decodeEntities[\s\S]*?\n {2}function postingFactsFromHtml\(html\) \{[\s\S]*?\r?\n {2}\}\r?\n/)?.[0];
  if (!block) throw new Error("postingFactsFromHtml was not found in the snippet.");
  const clean = (value: string) => (value || "").replace(/\s+/g, " ").trim();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- evaluates the repository's own snippet source
  return new Function("clean", `${block}; return postingFactsFromHtml;`)(clean) as (html: string) => Record<string, unknown>;
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
    const noCheck = postingFactsPayload({ availabilityStatus: "OPEN", checkMethod: "TEST" });
    expect(noCheck.availability).toBe("UNKNOWN");
    expect(noCheck.payload).toEqual({});
    expect(noCheck.ignored).toContain("availabilityStatus has no valid check time");

    const future = postingFactsPayload({ postedAt: "2026-12-01", checkMethod: "TEST", checkedAt: CHECKED_AT });
    expect(future.publishedAt).toBeNull();
    expect(future.ignored).toContain("postedAt is later than the check time");

    const both = postingFactsPayload({ postedAt: "2026-10-28", postedAtText: "2 weeks ago", checkMethod: "TEST", checkedAt: CHECKED_AT });
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
    });
  });

  it("reads relative text only when no absolute date is on the page", () => {
    expect(facts(GUEST_PAGE_OPEN_RELATIVE)).toMatchObject({ postedAt: null, postedAtText: "Reposted 3 days ago", validThrough: null, availabilityStatus: "OPEN" });
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
    });
  });

  it("emits the posting-fact fields for every saved job and records when the page was read", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "scripts", "linkedin", "export_saved_jobs.console.js"), "utf8");
    expect(source).toMatch(/Object\.assign\(job, postingFactsFromHtml\(html\), \{ postingCheckedAt: readAt \}\)/);
    expect(source).toMatch(/const needsFetch = \(job\) => job\.descriptionStatus !== "OK" \|\| !job\.postingCheckedAt;/);
    expect(source).toMatch(/window\.jdeLinkedInExport = \{ resume, refresh,/);
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
      expires_at: new Date(new Date(CHECKED_AT).getTime() + DAY).toISOString(),
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

describe("enrich:linkedin-saved command line", () => {
  it("is a dry run unless --apply is given", () => {
    expect(parseEnrichLinkedInSavedArguments(["export.json"])).toEqual({ filePath: "export.json", apply: false });
    expect(parseEnrichLinkedInSavedArguments(["export.json", "--apply"])).toEqual({ filePath: "export.json", apply: true });
    expect(parseEnrichLinkedInSavedArguments(["export.json", "--apply", "--dry-run"])).toEqual({ filePath: "export.json", apply: false });
    expect(() => parseEnrichLinkedInSavedArguments([])).toThrow(/Usage/);
    expect(() => parseEnrichLinkedInSavedArguments(["export.json", "--force"])).toThrow(/Unsupported argument/);
  });
});
