import { describe, expect, it } from "vitest";

import { ROLE_SHAPE_POLICY_VERSION, assessRoleShape } from "../../pipeline/roleShape.js";

// Synthetic sentences only. role_shape_v2: contract negation / permanent wording, and a strong cue for people management.
describe("role shape v2: contract negation and permanent wording", () => {
  const codes = (description: string, employmentType = "") => assessRoleShape({ title: "Analyst", description, employmentType }).signals.map((s) => s.code);

  it("the version moved with the detector change", () => {
    expect(ROLE_SHAPE_POLICY_VERSION).toBe("role_shape_v2");
  });

  it.each([
    "This is a permanent contract basis role.",
    "A full-time permanent contract role with benefits.",
    "This is not a fixed-term contract; the role is open-ended.",
    "No 6-month contract here, the position is indefinite.",
    "You will not be hired on a freelance basis.",
  ])("does not flag: %s", (text) => {
    expect(codes(text)).toEqual([]);
  });

  it("still flags a real contract and does not flag a permanent employment type", () => {
    expect(codes("A 6-month contract with a possible extension.")).toEqual(["CONTRACT_EMPLOYMENT"]);
    expect(codes("", "Fixed term contract")).toEqual(["CONTRACT_EMPLOYMENT"]);
    expect(codes("", "Permanent contract")).toEqual([]);
  });

  it("flags a later real contract after an earlier negated one", () => {
    expect(codes("This is not a fixed-term contract role. Separately, one team runs a 12 month contract engagement.")).toEqual(["CONTRACT_EMPLOYMENT"]);
  });
});

describe("role shape v2: people management needs a strong cue with a title", () => {
  const codes = (title: string, description: string) => assessRoleShape({ title, description }).signals.map((s) => s.code);

  it("an individual contributor with a senior or director title and one weak mention is not flagged", () => {
    expect(codes("Director, Applied AI Research", "You will contribute to performance reviews for the research programme.")).toEqual([]);
    expect(codes("Head of Data Science", "We hire and develop talent across the company; you will build models.")).toEqual([]);
  });

  it("a management title with a strong cue, or any two cues, is still flagged", () => {
    expect(codes("Director, Applied AI", "You will have five direct reports.")).toEqual(["PEOPLE_MANAGEMENT_CORE"]);
    expect(codes("Data Lead", "You will manage a team of six and run performance reviews.")).toEqual(["PEOPLE_MANAGEMENT_CORE"]);
    expect(codes("Data Lead", "Performance reviews and hire and develop the team are part of the job.")).toEqual(["PEOPLE_MANAGEMENT_CORE"]);
  });
});

describe("role shape v2: permanent wording only counts when it modifies the contract", () => {
  const codes = (description: string, employmentType = "") => assessRoleShape({ title: "Analyst", description, employmentType }).signals.map((s) => s.code);

  it.each([
    "This is a non-permanent contract role.",
    "A contract role, may convert to permanent after review.",
    "Contract basis; a permanent position may follow.",
    "This is a not permanent 6-month contract.",
  ])("flags: %s", (text) => {
    expect(codes(text)).toEqual(["CONTRACT_EMPLOYMENT"]);
  });

  it("a negated permanent employment type is still a contract, a plain permanent one is not", () => {
    expect(codes("", "Non-permanent contract")).toEqual(["CONTRACT_EMPLOYMENT"]);
    expect(codes("", "Permanent contract")).toEqual([]);
  });
});

describe("role shape v2: negation recall (review MED-3)", () => {
  const codes = (description: string, employmentType = "") => assessRoleShape({ title: "Analyst", description, employmentType }).signals.map((s) => s.code);

  it.each([
    "This is not a permanent role, 6-month contract.",
    "We offer no relocation, 12-month contract.",
    "A non‑permanent 6-month contract.",
    "A non–permanent 6-month contract.",
  ])("flags: %s", (text) => {
    expect(codes(text)).toEqual(["CONTRACT_EMPLOYMENT"]);
  });

  it("an employment type with a Unicode dash is still read", () => {
    expect(codes("", "Non‑permanent contract")).toEqual(["CONTRACT_EMPLOYMENT"]);
  });

  it("still does not flag a negation inside the contract clause", () => {
    expect(codes("This is not a fixed-term contract.")).toEqual([]);
  });

  // Known gap kept for a later change: an employment type such as CONTRACT_TO_HIRE is not matched by the word-boundary pattern.
  it.fails("CONTRACT_TO_HIRE employment type is not recognised yet (known gap)", () => {
    expect(codes("", "CONTRACT_TO_HIRE")).toEqual(["CONTRACT_EMPLOYMENT"]);
  });
});
