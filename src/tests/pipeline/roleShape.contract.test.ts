import { describe, expect, it } from "vitest";

import { assessRoleShape } from "../../pipeline/roleShape.js";

// Synthetic titles and sentences only.
describe("role shape: contract employment is kept and downranked", () => {
  it("flags the stored employment type", () => {
    const result = assessRoleShape({ title: "Data Scientist", description: "", employmentType: "CONTRACT" });
    expect(result.signals).toEqual([expect.objectContaining({ code: "CONTRACT_EMPLOYMENT", source: "EMPLOYMENT_TYPE" })]);
  });

  it.each(["This is a 6-month contract with extension.", "A twelve month fixed-term contract.", "Freelance engagement for a quarter."])("flags the posting wording: %s", (description) => {
    const result = assessRoleShape({ title: "Analyst", description });
    expect(result.signals.map((s) => s.code)).toEqual(["CONTRACT_EMPLOYMENT"]);
    expect(description.toLowerCase()).toContain(result.signals[0]!.quote.toLowerCase().slice(0, 12));
  });

  it("does not flag permanent roles or contract law work", () => {
    expect(assessRoleShape({ title: "Analyst", description: "", employmentType: "PERMANENT" }).signals).toEqual([]);
    expect(assessRoleShape({ title: "Legal Technologist", description: "You will review vendor contracts and contract templates." }).signals).toEqual([]);
  });

  it("only lowers rank by a small share", () => {
    expect(assessRoleShape({ title: "Analyst", description: "", employmentType: "CONTRACT" }).total_penalty).toBeLessThanOrEqual(0.05);
  });
});
