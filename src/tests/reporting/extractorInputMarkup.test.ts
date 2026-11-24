import { describe, expect, it } from "vitest";

import { MARKUP_IN_QUOTE, measureQuoteMarkup } from "../../reporting/extractorInputMarkup.js";
import { cleanPostingText } from "../../security/postingText.js";

// Synthetic postings only. The first two store the markup escaped, as some feeds do.
const ESCAPED =
  "&lt;p&gt;About the role&lt;/p&gt;&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;" +
  "&lt;li&gt;5+ years of experience with SQL&lt;/li&gt;" +
  "&lt;li&gt;Strong Python skills&lt;/li&gt;" +
  "&lt;li&gt;Experience with machine learning platforms&lt;/li&gt;&lt;/ul&gt;";
const DOUBLE_ESCAPED = ESCAPED.replaceAll("&lt;", "&amp;lt;").replaceAll("&gt;", "&amp;gt;");
const REAL_HTML =
  "<p>About the role</p><h3>Requirements</h3><ul><li>5+ years of experience with SQL</li>" +
  "<li>Strong Python skills</li><li>Experience with machine learning platforms</li></ul>";
const PLAIN =
  "About the role\n\nRequirements\n- 5+ years of experience with SQL\n- Strong Python skills\n- Experience with machine learning platforms\n";

describe("cleaning escaped markup", () => {
  it("removes escaped tags and keeps the text and the numbers", () => {
    const { text } = cleanPostingText(ESCAPED);
    expect(MARKUP_IN_QUOTE.test(text)).toBe(false);
    expect(text).toContain("5+ years of experience with SQL");
    expect(text.split("\n").length).toBeGreaterThan(3);
  });

  it("handles markup escaped twice", () => {
    expect(MARKUP_IN_QUOTE.test(cleanPostingText(DOUBLE_ESCAPED).text)).toBe(false);
  });

  it("leaves a literal comparison such as a &lt; b alone once decoded", () => {
    expect(cleanPostingText("team &lt; 10 and budget &gt; $2M").text).toBe("team < 10 and budget > $2M");
  });
});

describe("measureQuoteMarkup", () => {
  const measurement = measureQuoteMarkup([ESCAPED, DOUBLE_ESCAPED, REAL_HTML, PLAIN]);

  it("sees markup in quotes before cleaning when the posting is stored escaped", () => {
    expect(measurement.postingsContainingMarkup).toBe(3);
    expect(measurement.before.quotesWithMarkup).toBeGreaterThan(0);
    expect(measurement.before.jobsWithMarkupInAQuote).toBeGreaterThan(0);
  });

  it("sees none after cleaning", () => {
    expect(measurement.after.quotesWithMarkup).toBe(0);
    expect(measurement.after.jobsWithMarkupInAQuote).toBe(0);
    expect(measurement.after.quotes).toBeGreaterThan(0);
  });

  it("does not change the quotes of an already clean posting", () => {
    const clean = measureQuoteMarkup([PLAIN]);
    expect(clean.after).toEqual(clean.before);
  });
});
