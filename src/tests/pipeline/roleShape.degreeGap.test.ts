import { describe, expect, it } from "vitest";

import { applyRoleShapePenalty, assessRoleShape } from "../../pipeline/roleShape.js";

// Synthetic sentences only.
describe("role shape: degree gap is flagged and ranked lower, never a block", () => {
  it("flags a MUST degree the profile is short of, with the posting words", () => {
    const quote = "A doctoral degree in a quantitative subject is required.";
    const result = assessRoleShape({ title: "Research Scientist", description: "", degreeGapQuote: quote });
    expect(result.signals).toEqual([expect.objectContaining({ code: "DEGREE_GAP_FLAGGED", quote })]);
    expect(result.total_penalty).toBe(0.06);
    expect(applyRoleShapePenalty(0.7, result)).toBeGreaterThan(0.6);
  });

  it("no signal without a gap", () => {
    expect(assessRoleShape({ title: "Research Scientist", description: "", degreeGapQuote: null }).signals).toEqual([]);
  });
});
