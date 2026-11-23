import { describe, expect, it } from "vitest";

import { assessRoleShape } from "../../pipeline/roleShape.js";

// Synthetic titles and sentences only.
describe("role shape: people management as the core of the role", () => {
  const codes = (title: string, description = "") => assessRoleShape({ title, description }).signals.map((s) => s.code);

  it.each(["Head of Data Platform", "Director, Applied AI", "Engineering Manager, ML", "Vice President of Analytics"])("flags the title %s", (title) => {
    expect(codes(title)).toEqual(["PEOPLE_MANAGEMENT_CORE"]);
  });

  it("flags a description that is mostly about running a team (two cues), with a quote", () => {
    const description = "You will have six direct reports and own their performance reviews.";
    const result = assessRoleShape({ title: "Senior Data Lead", description });
    expect(result.signals).toHaveLength(1);
    expect(description).toContain(result.signals[0]!.quote);
  });

  it("does not flag product or program manager titles, or one passing mention", () => {
    expect(codes("Product Manager, Data")).toEqual([]);
    expect(codes("Program Manager", "You will mentor two junior colleagues.")).toEqual([]);
    expect(codes("Data Engineer", "Some line management experience is a plus.")).toEqual([]);
  });

  it("is a downrank: the penalty is below the cap and the score stays positive", () => {
    const result = assessRoleShape({ title: "Head of Data", description: "" });
    expect(result.total_penalty).toBeGreaterThan(0);
    expect(result.total_penalty).toBeLessThan(0.2);
  });
});
