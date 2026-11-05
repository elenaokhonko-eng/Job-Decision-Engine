import { describe, expect, it } from "vitest";
import { publicErrorSummary } from "../../security/publicErrorSummary.js";

describe("public provider error summaries", () => {
  it("does not expose echoed profile text, contact details, or request/response bodies", () => {
    const echoed = Object.assign(new Error(
      'Bad request: prompt="Senior data leader; email elena@example.test; phone +65 8123 4567; profile fact confidential" response body={"candidate":"Elena"}',
    ), {
      status: 400,
      code: "INVALID_ARGUMENT",
      response: { body: "same sensitive text" },
    });

    const summary = publicErrorSummary(echoed, "gemini");

    expect(summary).toContain("HTTP 400");
    expect(summary).toContain("INVALID_ARGUMENT");
    expect(summary).toContain("request rejected");
    expect(summary).not.toContain("elena@example.test");
    expect(summary).not.toContain("8123 4567");
    expect(summary).not.toContain("confidential");
    expect(summary).not.toContain("Senior data leader");
    expect(summary).not.toContain("same sensitive text");
    expect(summary.length).toBeLessThanOrEqual(240);
  });

  it("summarizes timeouts without including an arbitrary long error message", () => {
    const summary = publicErrorSummary(new Error(`timed out ${"private profile text ".repeat(100)}`), "openai");

    expect(summary).toContain("request timed out");
    expect(summary).not.toContain("private profile text");
    expect(summary.length).toBeLessThanOrEqual(240);
  });

  it("uses a redacted category when provider text has no known safe diagnostic", () => {
    expect(publicErrorSummary("role facts and candidate output were echoed", "unknown-provider"))
      .toBe("external request failed (details redacted)");
  });
});
