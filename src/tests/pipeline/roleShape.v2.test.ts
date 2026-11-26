import { describe, expect, it } from "vitest";

import { ROLE_SHAPE_POLICY_VERSION, assessRoleShape } from "../../pipeline/roleShape.js";

// Synthetic sentences only. role_shape_v3 (the file keeps its first name): contract negation / permanent wording, and a strong cue for people management.
describe("role shape v3: contract negation and permanent wording", () => {
  const codes = (description: string, employmentType = "") => assessRoleShape({ title: "Analyst", description, employmentType }).signals.map((s) => s.code);

  it("the version moved with the detector change", () => {
    expect(ROLE_SHAPE_POLICY_VERSION).toBe("role_shape_v3");
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

describe("role shape v3: people management needs a strong cue with a title", () => {
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

describe("role shape v3: permanent wording only counts when it modifies the contract", () => {
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

describe("role shape v3: negation recall (review MED-3)", () => {
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

  // A negation of something else in the same clause must not hide the contract (no punctuation between them).
  it.each([
    "We offer no relocation for this 12-month contract.",
    "We offer no relocation - 12-month contract.",
    "We offer no relocation (12-month contract).",
    "Not a permanent role - 6-month contract.",
    "Relocation is not offered for this 6-month contract.",
    "This role is not remote and is a 6-month contract.",
    "Visa sponsorship: No\n6-month contract",
    "This is not a permanent contract role.",
    "Never miss a deadline on this 6-month contract.",
  ])("flags a contract beside an unrelated negation: %s", (text) => {
    expect(codes(text)).toEqual(["CONTRACT_EMPLOYMENT"]);
  });

  it.each([
    "This is not a contract position.",
    "This isn’t a contract role.",
    "There is no contract position on this team.",
    "This is never a contract role.",
    "Great team. No 6-month contract here.",
    "We do not offer fixed-term contract arrangements; this is not a contract role.",
    "We cannot engage an independent contractor.",
    "You will not be employed as a freelancer.",
    "This is not a short-term or fixed-term contract.",
    "This is not a fixed‑term contract.",
  ])("does not flag a negation that governs the contract: %s", (text) => {
    expect(codes(text)).toEqual([]);
  });

  it("an employment type that says not a permanent contract is a contract", () => {
    expect(codes("", "Not a permanent contract")).toEqual(["CONTRACT_EMPLOYMENT"]);
  });

  it("still does not flag a negation inside the contract clause", () => {
    expect(codes("This is not a fixed-term contract.")).toEqual([]);
  });

  // Known gap kept for a later change: an employment type such as CONTRACT_TO_HIRE is not matched by the word-boundary pattern.
  it.fails("CONTRACT_TO_HIRE employment type is not recognised yet (known gap)", () => {
    expect(codes("", "CONTRACT_TO_HIRE")).toEqual(["CONTRACT_EMPLOYMENT"]);
  });
});

describe("role shape v3: a negation of something else never hides a contract (re-review A)", () => {
  const codes = (description: string) => assessRoleShape({ title: "Analyst", description }).signals.map((s) => s.code);

  it.each([
    "Visa sponsorship is not offered on a 12-month contract",
    "Visa sponsorship is not offered on a fixed-term contract",
    "Medical benefits are not offered through the 6-month contract",
    "Overtime not offered on a contract basis",
    "Sponsorship not offered on contract role",
    "Relocation: no 6-month contract",
    "Why not be a freelancer",
    "Visa sponsorship: No 6-month contract",
    "Remote: No Contract role: 12 months",
    "Like it or not 6-month contract",
    "Like it or not a 6-month contract",
    "Sponsorship available? No 6-month contract",
    "We have a long list of perks and a great office and absolutely no 6-month contract surprises",
  ])("flags: %s", (text) => {
    expect(codes(text)).toEqual(["CONTRACT_EMPLOYMENT"]);
  });

  it("a window cut in the middle of the text is not treated as the start of the text", () => {
    // The 60 characters before the phrase begin exactly at "no".
    expect(codes(`Perks and cake no${" ".repeat(58)}6-month contract`)).toEqual(["CONTRACT_EMPLOYMENT"]);
  });

  // Plural phrases are not in the contract pattern at all (unchanged by this PR).
  it("does not read plural contractor wording", () => {
    expect(codes("No agencies or freelancers please.")).toEqual([]);
  });
});

describe("role shape v3: negated or conditional permanent is still a contract (re-review B)", () => {
  const codes = (description: string, employmentType = "") => assessRoleShape({ title: "Analyst", description, employmentType }).signals.map((s) => s.code);

  it.each([
    "This isn't a permanent contract role",
    "This isn’t a permanent contract role",
    "There is no a permanent contract role",
    "This is no permanent contract role",
    "This is never a permanent contract role",
    "This is not the permanent contract role",
    "This is not strictly a permanent contract role",
    "This is not an open-ended contract role",
    "This is not  a  permanent contract role",
    "This is not a permanent contract role",
    "This is not\na permanent contract role",
    "Temp-to-permanent contract role",
    "A contract-to-permanent contract position",
    "Moving to permanent contract basis later",
    "Instead of a permanent contract position",
    "Rather than a permanent contract position",
    "A non-permanent contract role",
  ])("flags: %s", (text) => {
    expect(codes(text)).toEqual(["CONTRACT_EMPLOYMENT"]);
  });

  it.each([
    "This is a permanent contract role",
    "An open-ended contract position",
    "An indefinite contract basis",
    "Strictly a permanent contract position",
  ])("does not flag: %s", (text) => {
    expect(codes(text)).toEqual([]);
  });

  it.each([
    "Contract to permanent",
    "Contract-to-Permanent",
    "Contract (may convert to permanent)",
    "Contract with permanent conversion",
    "FIXED_TERM (possibility of permanent)",
    "Contract (isn't permanent)",
    "Contract - no permanent headcount",
  ])("employment type stays a contract: %s", (type) => {
    expect(codes("", type)).toEqual(["CONTRACT_EMPLOYMENT"]);
  });

  it.each([
    "Permanent contract",
    "Full-time, Permanent contract",
    "Open-ended contract",
    "Indefinite employment contract",
  ])("employment type is permanent: %s", (type) => {
    expect(codes("", type)).toEqual([]);
  });
});

describe("role shape v3: denied people management is not management (re-review C)", () => {
  const codes = (title: string, description: string) => assessRoleShape({ title, description }).signals.map((s) => s.code);

  it.each([
    "This role has no direct reports",
    "There is no line management responsibility",
    "No people management",
    "No direct reports and no people management responsibilities",
    "Advise on line management and performance reviews matters",
    "Advise on people management, performance reviews and policy",
    "Advising managers on performance reviews; advises on line management",
    "A senior role without direct reports",
    "You will not have direct reports",
    "You will not have any direct reports",
  ])("does not flag, even with a management title: %s", (text) => {
    expect(codes("Director, Applied AI", text)).toEqual([]);
  });

  it("one other duty beside advisory work is only one cue", () => {
    expect(codes("Data Lead", "Advise on line management and performance reviews matters. Lead the team through the audit.")).toEqual([]);
    expect(codes("Data Lead", "Advise on people management, performance reviews and policy. Lead the team through the audit.")).toEqual([]);
  });

  it("a later real cue still counts after a denied one", () => {
    expect(codes("Director, Applied AI", "No direct reports at first. Within a year you will have four direct reports.")).toEqual(["PEOPLE_MANAGEMENT_CORE"]);
  });

  it.each([
    ["Data Lead", "Manage our team of 8 and run performance reviews"],
    ["Engineering Manager", "Own performance reviews and career growth for your engineers"],
    ["Engineering Manager", "Manage and develop engineering managers; conduct performance reviews"],
    ["Head of AI", "lead the team and run performance reviews"],
    ["Data Lead", "Manage the team and run performance reviews"],
    ["Data Lead", "Career development of the reports and performance reviews are yours"],
    ["Data Lead", "Career growth of your team; hiring and retain; "],
    ["Director of Engineering", "You will line manage four analysts."],
    ["Director of Engineering", "People management is central."],
    ["Director of Engineering", "You will lead engineering managers."],
    ["Director of Engineering", "Lead the team of analysts."],
    ["Director of Engineering", "Manage our global team of analysts."],
    ["Director of Engineering", "Build and grow a distributed team of analysts."],
  ])("flags %s: %s", (title, text) => {
    expect(codes(title, text)).toEqual(["PEOPLE_MANAGEMENT_CORE"]);
  });

  it("building a company team is not by itself running one", () => {
    expect(codes("Director, Applied AI", "Join us as we grow our team of experts.")).toEqual([]);
  });

  it("quotes the strong cue even when a weak one comes first", () => {
    const description = `Performance reviews happen twice a year. ${"The work is mostly modelling. ".repeat(5)}You will have two direct reports.`;
    const [signal] = assessRoleShape({ title: "Data Lead", description }).signals;
    expect(signal!.code).toBe("PEOPLE_MANAGEMENT_CORE");
    expect(signal!.quote).toContain("direct reports");
    expect(signal!.quote).not.toContain("Performance reviews");
  });
});
