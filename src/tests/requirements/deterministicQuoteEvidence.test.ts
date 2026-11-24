import { describe, expect, it } from "vitest";

import { DETERMINISTIC_EXTRACTOR_VERSION, extractDeterministicRequirements } from "../../requirements/deterministicExtractors.js";

const ID = "00000000-0000-4000-8000-000000000000";
const run = (description_text: string) =>
  extractDeterministicRequirements({ canonical_job_id: ID, job_version_id: ID, description_text });

// Synthetic postings only: plain, real HTML, escaped HTML, entities and CRLF line ends.
const POSTINGS: ReadonlyArray<[string, string]> = [
  ["plain", "Requirements\n- Must have 5+ years of SQL\n- Strong Python skills\n- Experience with machine learning platforms\n"],
  [
    "real HTML",
    "<h3>Requirements</h3><ul><li>Must have <b>5+ years</b> of SQL</li><li>Strong Python skills</li>" +
      "<li>Experience with machine learning platforms</li></ul>",
  ],
  [
    "escaped HTML",
    "&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Must have 5+ years of SQL&lt;/li&gt;" +
      "&lt;li&gt;Strong Python skills&lt;/li&gt;&lt;li&gt;Experience with machine learning platforms&lt;/li&gt;&lt;/ul&gt;",
  ],
  ["entities", "Requirements\n- Must have 5&nbsp;years &amp; more of SQL\n- Strong Python &amp; R skills\n- Hybrid, 3 days a week in the office\n"],
  ["CRLF", "Requirements\r\n- Must have 5+ years of SQL\r\n- Strong Python skills\r\n- Experience with machine learning platforms\r\n"],
];

describe("deterministic extractor evidence", () => {
  it("is on the measured version", () => {
    expect(DETERMINISTIC_EXTRACTOR_VERSION).toBe("deterministic_v6");
  });

  it.each(POSTINGS)("every stored quote is a substring of the raw posting at its offsets (%s)", (_name, raw) => {
    const { requirements } = run(raw);
    for (const requirement of requirements) {
      if (!requirement.quote_text) continue;
      expect(raw.includes(requirement.quote_text)).toBe(true);
      expect(raw.slice(requirement.quote_start_offset!, requirement.quote_end_offset!)).toBe(requirement.quote_text);
    }
  });

  it("produces at least one quoted requirement for the markup and entity postings, so the check is not vacuous", () => {
    for (const [, raw] of POSTINGS) {
      expect(run(raw).requirements.filter((r) => r.quote_text).length).toBeGreaterThan(0);
    }
  });
});
