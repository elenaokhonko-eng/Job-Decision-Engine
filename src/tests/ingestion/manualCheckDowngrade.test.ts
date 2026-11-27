import { describe, expect, it } from "vitest";

import { fetchJobContent, type JobContentResult } from "../../ingestion/jobContentFetcher.js";
import { downgradeForManualCheck, isClearlyFutureIsoDate, type ManualPage } from "../../ingestion/manualCheckDowngrade.js";

// Synthetic pages through the real shared reader with a fake fetch, then the manual-only rule.
const TITLE = "Synthetic Platform Engineer";
const DESCRIPTION = [
  "Responsibilities", "Build and operate synthetic data pipelines for an imaginary engineering organisation, end to end.",
  "Design reliable services, review changes, write documentation and support colleagues across several teams.",
  "Requirements", "Five years of software engineering with TypeScript and PostgreSQL in production systems.",
  "Experience with data modelling, observability, incident response and automated testing is expected.",
].join("\n").repeat(3);
const NOW = new Date("2026-03-10T12:00:00Z");

async function read(html: string, status = 200): Promise<{ reader: JobContentResult; page: ManualPage }> {
  const reader = await fetchJobContent("https://careers.example.test/jobs/1", { title: TITLE, companyName: "Example Synthetic" }, {
    now: () => NOW,
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchOnce: async (url) => ({ status, headers: { "content-type": "text/html" }, body: Buffer.from(html), url: url.toString() }),
  });
  return { reader, page: { status, html } };
}

async function manual(html: string, status = 200) {
  const { reader, page } = await read(html, status);
  return { reader: reader.kind, ...downgradeForManualCheck(reader, page, NOW) };
}

const full = (extra = "", head = "") =>
  `<html><head>${head}</head><body><main><h1>${TITLE}</h1>${extra}<p>Example Synthetic</p><p>${DESCRIPTION}</p></main></body></html>`;
const jsonLd = (validThrough: unknown) => `<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org", "@type": "JobPosting", title: TITLE, description: DESCRIPTION,
  hiringOrganization: { "@type": "Organization", name: "Example Synthetic" }, validThrough,
})}</script>`;

describe("an open page", () => {
  it("stays open without closure wording", async () => {
    expect(await manual(full())).toMatchObject({ reader: "COMPLETE", reason: null, result: { kind: "COMPLETE" } });
  });

  it.each([
    "No longer accepting applications",
    "We are no longer accepting applications.",
    "Applications are now closed.",
    "Applications have closed.",
    "This position has now been filled.",
    "The position has been filled.",
    "This vacancy has now closed.",
    "This job is no longer active.",
    "This job has been closed.",
    "Job expired",
    "This job is <strong>no longer</strong>&nbsp;accepting applications",
    "If you have not heard from us, assume this position has been filled.",
  ])("is cannot-tell, never closed, with: %s", async (sentence) => {
    for (const html of [full(`<p>${sentence}</p>`), full().replace("<main>", `<div class="alert">${sentence}</div><main>`)]) {
      const outcome = await manual(html);
      expect(outcome.reader).toBe("COMPLETE");
      expect(outcome).toMatchObject({ reason: "CLOSURE_WORDING", result: { kind: "BLOCKED" }, checkByHand: false });
    }
  });

  it("reads closure wording in the page title too", async () => {
    expect((await manual(full("", "<title>Job expired | Example Synthetic</title>"))).reason).toBe("CLOSURE_WORDING");
  });

  it("stays open only when every validThrough is clearly in the future", async () => {
    expect((await manual(full("", jsonLd("2026-06-01T00:00:00Z")))).reason).toBeNull();
    expect((await manual(full("", jsonLd("2026-06-01")))).reason).toBeNull();
    for (const value of ["2026-03-09", "2026-03-10", "2026-03-10T13:00:00", "01/06/2026", "June 2026", "2026-13-40", "", null, 1790812800]) {
      expect((await manual(full("", jsonLd(value)))).reason, String(value)).toBe("VALID_THROUGH_NOT_CLEARLY_FUTURE");
    }
    for (const markup of [
      '<meta itemprop="validThrough" content="2026-03-01">', '<meta content="2026-03-01" itemprop="validThrough">',
      '<time itemprop="validThrough" datetime="2026-03-01">soon</time>', '<span itemprop="validThrough">next week</span>',
    ]) {
      expect((await manual(full(markup))).reason, markup).toBe("VALID_THROUGH_NOT_CLEARLY_FUTURE");
    }
    expect((await manual(full('<meta itemprop="validThrough" content="2026-06-01">'))).reason).toBeNull();
    expect(isClearlyFutureIsoDate("2026-03-10T12:30:00+00:00", NOW)).toBe(true);
    expect(isClearlyFutureIsoDate("2026-03-10T19:00:00+08:00", NOW)).toBe(false);
  });
});

describe("a closed page", () => {
  it.each([
    "<p>This job is not available at this time.</p>",
    "<p>This job is no longer available. Our site is down for maintenance.</p>",
    "<noscript>This job is no longer available. Please try again later.</noscript>",
  ])("is cannot-tell with maintenance wording: %s", async (body) => {
    const outcome = await manual(`<html><body>${body}</body></html>`);
    expect(outcome.reader).toBe("UNAVAILABLE");
    expect(outcome).toMatchObject({ reason: "MAINTENANCE_WORDING", result: { kind: "BLOCKED" }, checkByHand: false });
  });

  it("stays closed, flagged for a check by hand when only the wording says so", async () => {
    expect(await manual("<html><body><p>This position has been filled.</p></body></html>"))
      .toMatchObject({ reason: null, checkByHand: true, result: { kind: "UNAVAILABLE" } });
    expect(await manual("<html><body>gone</body></html>", 404))
      .toMatchObject({ reason: null, checkByHand: false, result: { kind: "UNAVAILABLE" } });
  });
});

describe("the rule only ever takes a verdict back", () => {
  it("never creates open or closed from a result that was neither", () => {
    const html = "<title>Job expired</title><p>No longer accepting applications. Maintenance.</p>";
    for (const result of [
      { kind: "BLOCKED", reason: "UNSUPPORTED_SOURCE" }, { kind: "RETRYABLE_FAILURE", reason: "x" }, { kind: "IDENTITY_CONFLICT", reason: "x" },
    ] as JobContentResult[]) {
      expect(downgradeForManualCheck(result, { status: 200, html }, NOW)).toEqual({ result, reason: null, checkByHand: false });
    }
  });

  it("stays linear on a megabyte of unclosed tags", () => {
    const open = { kind: "COMPLETE", posting: { availability: "UNKNOWN", title: TITLE, description: "", expiresAt: null } } as unknown as JobContentResult;
    for (const unit of ["<script ", "<style>", "<head>", "<!--", "<title", "<p ", "<", "<noscript>", 'itemprop="validThrough" <', '"validThrough": ']) {
      const html = unit.repeat(Math.ceil(1_048_576 / unit.length));
      const started = performance.now();
      downgradeForManualCheck(open, { status: 200, html }, NOW);
      expect(performance.now() - started, unit).toBeLessThan(2_000);
    }
  });
});
