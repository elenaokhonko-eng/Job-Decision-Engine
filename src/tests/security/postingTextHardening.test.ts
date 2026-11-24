import { describe, expect, it } from "vitest";

import { MAX_POSTING_CHARS, cleanPostingText } from "../../security/postingText.js";

// Synthetic input only. Time bounds are generous (CI machines vary) but far below the quadratic cost.
function timed<T>(run: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = run();
  return { result, ms: performance.now() - start };
}
const BOUND_MS = 1500;

describe("bounded work on hostile input", () => {
  it.each([
    ["unterminated script tags", "<script ".repeat(100_000)],
    ["unterminated comments", "<!--".repeat(100_000)],
    ["unterminated style blocks", "<style>".repeat(100_000)],
    ["bare angle brackets", "<".repeat(300_000)],
    ["half tags", "<a ".repeat(100_000)],
    ["entity soup", "&amp;lt;".repeat(100_000)],
    ["blank lines before a role marker", "\n".repeat(200_000) + "system"],
    ["repeated attribute starts", "<a x=\"".repeat(100_000)],
    ["repeated escaped tag starts", "&lt;li ".repeat(100_000)],
  ])("%s finish within the bound", (_name, input) => {
    const { ms } = timed(() => cleanPostingText(input));
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("a long ordinary posting is returned unchanged and quickly", () => {
    const line = "Experience with data platforms and SQL is required.\n";
    const input = line.repeat(20_000);
    const { result, ms } = timed(() => cleanPostingText(input));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(result.text).toBe(input.trim());
    expect(result.report.truncatedChars).toBe(0);
  });

  it("cuts input above the cap and says how much was cut", () => {
    const { text, report } = cleanPostingText("a".repeat(MAX_POSTING_CHARS + 123));
    expect(report.truncatedChars).toBe(123);
    expect(text.length).toBe(MAX_POSTING_CHARS);
  });
});

describe("what counts as a tag", () => {
  it("keeps text that only looks like a tag and counts it", () => {
    const { text, report } = cleanPostingText("Skills: <Python or Java> and <5 years of SQL> needed");
    expect(text).toBe("Skills: <Python or Java> and <5 years of SQL> needed");
    expect(report.tagLikeKeptAsText).toBeGreaterThanOrEqual(1);
  });

  it("strips known tags with attributes, closing tags and self-closing tags", () => {
    const { text, report } = cleanPostingText('<p class="intro">Hello<br/>world</p><a href="https://example.test/x">link</a>');
    expect(text).toBe("Hello\nworld\nlink");
    expect(report.htmlStripped).toBe(true);
  });

  it("does not treat an unknown element name as markup", () => {
    expect(cleanPostingText("use <T> for generics").text).toBe("use <T> for generics");
  });
});

describe("blocks that are dropped are counted", () => {
  it("drops script and style bodies and counts them", () => {
    const { text, report } = cleanPostingText("<style>p{color:red}</style>Visible<script>alert(1)</script> text");
    expect(text).toBe("Visible text");
    expect(report.scriptStyleBlocksDropped).toBe(2);
  });

  it("drops comments and counts them", () => {
    const { text, report } = cleanPostingText("A<!-- hidden -->B");
    expect(text).toBe("A B");
    expect(report.commentsDropped).toBe(1);
  });

  it("keeps the body of an unterminated script and reports it", () => {
    const { text, report } = cleanPostingText("Intro <script>Must have 5+ years of SQL");
    expect(text).toContain("Must have 5+ years of SQL");
    expect(report.unterminatedBlocks).toBe(1);
    expect(report.scriptStyleBlocksDropped).toBe(0);
  });
});

describe("entities and characters", () => {
  it("decodes numeric and hex entities", () => {
    expect(cleanPostingText("&#53;+ years &#x53;QL").text).toBe("5+ years SQL");
  });

  it("decodes escaped markup, once or twice", () => {
    expect(cleanPostingText("&lt;li&gt;5+ years&lt;/li&gt;").text).toBe("5+ years");
    expect(cleanPostingText("&amp;lt;li&amp;gt;5+ years&amp;lt;/li&amp;gt;").text).toBe("5+ years");
  });

  it("leaves a literal escape that is not markup as visible text", () => {
    expect(cleanPostingText("write &amp;lt; to show a less-than sign").text).toBe("write &lt; to show a less-than sign");
  });

  it("keeps unicode text, composes combining marks, removes invisible characters", () => {
    const { text, report } = cleanPostingText("Café 日本語 résumé​‮");
    expect(text).toBe("Café 日本語 résumé");
    expect(report.invisibleCharsRemoved).toBe(2);
  });

  it("handles empty, whitespace-only, non-string and markup-only input", () => {
    for (const input of ["", "   \n\t ", undefined, null, 7, {}, "<p></p><br/><div> </div>"]) {
      expect(cleanPostingText(input).text).toBe("");
    }
  });
});
