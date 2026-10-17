import { describe, expect, it } from "vitest";
import { scoreCultureEvidenceFromQuote } from "../../services/cultureEvidenceScoring.js";

describe("culture evidence scoring", () => {
  it("derives autonomy scores from recognized positive quote indicators", () => {
    expect(
      scoreCultureEvidenceFromQuote("AUTONOMY", "Work independently with minimal supervision.")
    ).toBe(80);
  });

  it("derives lower autonomy scores from recognized negative quote indicators", () => {
    expect(
      scoreCultureEvidenceFromQuote("AUTONOMY", "Close supervision with approval required for each change.")
    ).toBe(20);
  });

  it("preserves unknown when a quote contains conflicting evidence", () => {
    expect(
      scoreCultureEvidenceFromQuote(
        "AUTONOMY",
        "Work independently with close supervision."
      )
    ).toBeNull();
  });

  it("preserves unknown when the quote negates its only indicator", () => {
    expect(
      scoreCultureEvidenceFromQuote("SENSORY_WORKLOAD_RISK", "This is not a fast-paced environment.")
    ).toBeNull();
  });

  it("preserves unknown when the quote has no recognized signal indicators", () => {
    expect(scoreCultureEvidenceFromQuote("FOCUS_PROTECTION", "Async-first collaboration.")).toBeNull();
  });
});
