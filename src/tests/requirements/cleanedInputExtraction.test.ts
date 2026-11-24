import { describe, expect, it } from "vitest";

import { DETERMINISTIC_EXTRACTOR_VERSION, extractDeterministicRequirements } from "../../requirements/deterministicExtractors.js";
import { extractDeterministicRequirementsFromPosting } from "../../requirements/cleanedInputExtraction.js";
import { anchorQuoteToRaw } from "../../security/quoteAnchor.js";

const ID = "00000000-0000-4000-8000-000000000000";
const input = (description_text: string) => ({ canonical_job_id: ID, job_version_id: ID, description_text });

// Synthetic postings only.
const HTML_POSTING =
  "<h3>Requirements</h3><ul><li>Must have <b>5+ years</b> of SQL</li><li>Strong Python skills</li>" +
  "<li>Experience with machine learning platforms</li></ul>";
const ESCAPED_POSTING =
  "&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Must have &lt;b&gt;5+ years&lt;/b&gt; of SQL&lt;/li&gt;" +
  "&lt;li&gt;Strong Python skills&lt;/li&gt;&lt;li&gt;Experience with machine learning platforms&lt;/li&gt;&lt;/ul&gt;";
const PLAIN_POSTING = "Requirements\n- Must have 5+ years of SQL\n- Strong Python skills\n- Experience with machine learning platforms\n";

describe("evidence invariant: every stored quote is verifiable against the stored raw text", () => {
  it.each([
    ["real HTML", HTML_POSTING],
    ["escaped HTML", ESCAPED_POSTING],
    ["plain text", PLAIN_POSTING],
  ])("%s", (_name, raw) => {
    const { requirements } = extractDeterministicRequirementsFromPosting(input(raw));
    expect(requirements.filter((r) => r.quote_text).length).toBeGreaterThan(0);
    for (const requirement of requirements) {
      if (requirement.quote_text === null || requirement.quote_text === undefined) {
        expect(requirement.quote_start_offset ?? null).toBeNull();
        expect(requirement.quote_end_offset ?? null).toBeNull();
        continue;
      }
      expect(raw.includes(requirement.quote_text)).toBe(true);
      expect(raw.slice(requirement.quote_start_offset!, requirement.quote_end_offset!)).toBe(requirement.quote_text);
    }
  });

  it("anchors the quote of the markup example to the raw span, and keeps the clean text in requirement_text", () => {
    const { requirements } = extractDeterministicRequirementsFromPosting(input(HTML_POSTING));
    const sql = requirements.find((r) => r.quote_text?.includes("5+") && r.quote_text.includes("SQL"));
    expect(sql).toBeDefined();
    expect(HTML_POSTING.includes(sql!.quote_text!)).toBe(true);
    expect(sql!.requirement_text).not.toMatch(/<\/?b>/);
  });

  it("gives the same requirements as the plain extractor for an already clean posting", () => {
    expect(extractDeterministicRequirementsFromPosting(input(PLAIN_POSTING)).requirements)
      .toEqual(extractDeterministicRequirements(input(PLAIN_POSTING)).requirements);
  });
});

describe("the extractor sees cleaned text", () => {
  it("an escaped posting yields the same requirement texts as the plain one", () => {
    const texts = (raw: string) => extractDeterministicRequirementsFromPosting(input(raw)).requirements.map((r) => r.requirement_text);
    expect(texts(ESCAPED_POSTING)).toEqual(texts(HTML_POSTING));
    expect(texts(ESCAPED_POSTING).some((t) => /[<>]|&lt;|&gt;/.test(t))).toBe(false);
  });
});

describe("anchorQuoteToRaw", () => {
  it("returns null when the quote is not in the raw text", () => {
    expect(anchorQuoteToRaw("<p>Python skills</p>", "Rust skills", 0)).toBeNull();
  });

  it("chooses the occurrence closest to the hint", () => {
    const raw = "SQL skills. ".repeat(5);
    expect(anchorQuoteToRaw(raw, "SQL skills", 12)!.start).toBe(12);
  });

  it("matches across tags, entities and whitespace runs", () => {
    const raw = "<li>Must&nbsp;have\n  <b>5+</b> years &amp; more</li>";
    const hit = anchorQuoteToRaw(raw, "Must have 5+ years & more", 0)!;
    expect(raw.slice(hit.start, hit.end)).toBe(hit.quote);
    expect(hit.quote.startsWith("Must")).toBe(true);
    expect(hit.quote.endsWith("more")).toBe(true);
  });

  it("does not run away on hostile input", () => {
    const raw = "<b>".repeat(100_000) + "x";
    const start = performance.now();
    anchorQuoteToRaw(raw, "needle text", 0);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});

describe("extractor version identity", () => {
  it("is pinned to v7: cleaned input and raw-anchored quotes are a new behaviour", () => {
    expect(DETERMINISTIC_EXTRACTOR_VERSION).toBe("deterministic_v7");
  });
});
