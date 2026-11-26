import { describe, expect, it } from "vitest";

import { fetchJobContent, type JobContentResult } from "../../ingestion/jobContentFetcher.js";
import { outcomeFromPageRead } from "../../tasks/availabilityRecheck.js";

// Synthetic employer pages, read through the real reader with a fake fetch.
const TITLE = "Synthetic Platform Engineer";
const DESCRIPTION = [
  "Responsibilities", "Build and operate synthetic data pipelines for an imaginary engineering organisation, end to end.",
  "Design reliable services, review changes, write documentation and support colleagues across several teams.",
  "Requirements", "Five years of software engineering with TypeScript and PostgreSQL in production systems.",
  "Experience with data modelling, observability, incident response and automated testing is expected.",
].join("\n").repeat(3);
const NOW = new Date("2026-03-10T12:00:00Z");

async function read(body: string, posting?: Record<string, unknown>): Promise<JobContentResult> {
  const jsonLd = posting === undefined ? "" : `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org", "@type": "JobPosting", title: TITLE, description: DESCRIPTION,
    hiringOrganization: { "@type": "Organization", name: "Example Synthetic" }, ...posting,
  })}</script>`;
  const html = `<html><body>${jsonLd}${body}</body></html>`;
  return fetchJobContent("https://careers.example.test/jobs/1", { title: TITLE, companyName: "Example Synthetic" }, {
    now: () => NOW,
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchOnce: async (url) => ({ status: 200, headers: { "content-type": "text/html" }, body: Buffer.from(html), url: url.toString() }),
  });
}

const outcome = async (body: string, posting?: Record<string, unknown>) => outcomeFromPageRead(await read(body, posting)).kind;
const full = (extra = "") => `<main><h1>${TITLE}</h1>${extra}<p>Example Synthetic</p><p>${DESCRIPTION}</p></main>`;

describe("a page that still shows the posting", () => {
  it("is open without a closure statement", async () => {
    expect(await outcome(full(), {})).toBe("OPEN");
    expect(await outcome(full())).toBe("OPEN");
  });

  it.each([
    "This job is no longer accepting applications.",
    "This position has been filled.",
    "This vacancy is now closed.",
    "This job posting has expired.",
    "We are no longer accepting applications for this role.",
  ])("is not open when it says: %s", async (sentence) => {
    for (const body of [full(`<p>${sentence}</p>`), `<div class="alert">${sentence}</div>${full()}`]) {
      expect(await outcome(body, {}), body.slice(0, 80)).toBe("CLOSED_BY_PAGE");
    }
    expect(await outcome(full(`<p>${sentence}</p>`))).toBe("CLOSED_BY_PAGE");
  });

  it.each([
    "Note: we are no longer accepting applications from recruitment agencies for this role.",
    "This role is no longer accepting applications from agencies.",
    "Apply early: once this position has been filled the advert is removed.",
    "If this job is closed, see our other openings.",
    "Our previous office is closed.",
  ])("stays open for wording that does not close it: %s", async (sentence) => {
    expect(await outcome(full(`<p>${sentence}</p>`), {})).toBe("OPEN");
  });

  it("ignores closure wording that is not shown to a reader or belongs to a side list", async () => {
    const sentence = "This job is no longer accepting applications.";
    for (const hidden of [`<noscript>${sentence}</noscript>`, `<template>${sentence}</template>`, `<aside>${sentence}</aside>`,
      `<script>const message = "${sentence}";</script>`]) {
      expect(await outcome(full() + hidden, {}), hidden).toBe("OPEN");
    }
  });

  it("is not open once its validThrough has passed, and stays open before it", async () => {
    expect(await outcome(full(), { validThrough: "2026-03-09T23:00:00Z" })).toBe("CLOSED_BY_PAGE");
    expect(await outcome(full(), { validThrough: "2026-03-09" })).toBe("CLOSED_BY_PAGE");
    expect(await outcome(full(), { validThrough: "2026-03-10" })).toBe("OPEN");
    expect(await outcome(full(), { validThrough: "2026-03-10T13:00:00Z" })).toBe("OPEN");
    expect(await outcome(full(), { validThrough: "not a date" })).toBe("OPEN");
  });
});

describe("a page that shows no posting", () => {
  it.each([
    "<p>Our careers site is not available at this time. Please try again later.</p>",
    "<p>This page is not available at this time due to maintenance.</p>",
    "<p>Job search is not available at this time.</p>",
    "<noscript><p>This job is not available at this time.</p></noscript>",
    "<noscript>This job is no longer available.</noscript><div id='app'></div>",
  ])("is cannot-tell for maintenance or script-less wording: %s", async (body) => {
    expect(await outcome(body)).toBe("CANNOT_TELL");
  });

  it.each([
    "<p>You can't view this job because it's not available at this time.</p>",
    "<p>This position is not available at this time.</p>",
    "<p>The job you are looking for is no longer available.</p>",
  ])("is still closed when it says so about the job: %s", async (body) => {
    expect(await outcome(body)).toBe("CLOSED_BY_PAGE");
  });
});
