/**
 * gate-2026-11.10: the office-days rule reads counts spelled in words ("four days
 * in the office") as it already read digits ("4 days in the office"). Same
 * thresholds (config/policies/workability.yml: max 3 per week, hard fail at 4).
 *
 * Synthetic sentences only, none copied from a stored posting.
 */
import { describe, expect, it } from "vitest";
import { applyGlobalGates, extractHybridAttendance } from "../../src/services/criteria.js";
import { applyPersistedRequirementGates } from "../../src/pipeline/hardGate.js";
import { readOfficeDayWords } from "../../src/pipeline/officeDayWords.js";
import { findOfficeFirstDays } from "../../src/pipeline/officeFirstDays.js";
import { loadWorkabilityPolicy } from "../../src/pipeline/workabilityPolicy.js";
import { GATE_VERSION } from "../../src/contracts/version.js";

const policy = loadWorkabilityPolicy();
const DUTIES = "Build machine learning data pipelines in Python and Spark for portfolio analytics.";

function gate(sentence: string, workplaceType = "HYBRID", gatePolicy = policy) {
  return applyGlobalGates(
    {
      id: "synthetic",
      title: "Senior Data Engineer",
      company_name: "Acme Analytics",
      source: "canonical",
      location: "Singapore",
      workplace_type: workplaceType,
      raw_description: `${DUTIES} ${sentence}`,
    } as any,
    gatePolicy,
    null,
  );
}

const officeReject = (result: ReturnType<typeof gate>) =>
  result.status === "HARD_REJECT" && result.rejection_codes.includes("GATE_HIGH_OFFICE_DAYS");

describe("office-day counts in words", () => {
  it("keeps the existing thresholds and carries the new gate version", () => {
    expect([policy.maxOfficeDaysPerWeek, policy.hardFailOfficeDaysPerWeek]).toEqual([3, 4]);
    expect(GATE_VERSION).toBe("gate-2026-11.10");
  });

  it.each([
    "You will spend four days in the office.",
    "We expect five days a week on-site.",
    "Plan on four to five days in the office.",
    "Plan on 4-5 days in the office.",
    "The team meets four or five days per week in the office.",
    "This means four (4) days in the office.",
    "Four days per week at the office are expected.",
    "Five days/week onsite.",
    "The pattern is three to four days in the office.",
    "At least FOUR days in the office.",
  ])("rejects: %s", (sentence) => {
    for (const workplaceType of ["HYBRID", "UNKNOWN", "ASSUMED_HYBRID"]) {
      expect(officeReject(gate(sentence, workplaceType)), `${workplaceType}: ${sentence}`).toBe(true);
    }
  });

  it.each([
    ["four days in the office", "4 days in the office"],
    ["five days a week on-site", "5 days a week on-site"],
    ["four to five days in the office", "4 to 5 days in the office"],
    ["three to four days in the office", "3-4 days in the office"],
    ["up to four days in the office", "up to 4 days in the office"],
    ["two days in the office", "2 days in the office"],
    ["up to three days in the office", "up to 3 days in the office"],
  ])("judges '%s' like '%s'", (words, digits) => {
    const spelled = gate(`The pattern is ${words}.`);
    const numeric = gate(`The pattern is ${digits}.`);
    expect(spelled.status).toBe(numeric.status);
    expect(spelled.rejection_codes).toEqual(numeric.rejection_codes);
  });

  it("quotes the posting's own words as evidence", () => {
    // With on-site allowed, the office-day check itself writes the evidence quote.
    const result = gate("You will spend Four days in the office.", "UNKNOWN", { ...policy, allowedWorkModes: ["REMOTE", "HYBRID", "ONSITE"] });
    expect(result.rejection_codes).toContain("GATE_HIGH_OFFICE_DAYS");
    expect(result.evidence_quotes.join(" ")).toContain("four days in the office");
    expect(result.evidence_quotes.join(" ")).not.toContain("4");
    expect(extractHybridAttendance("four to five days in the office")).toMatchObject({
      office_days_min: 4,
      office_days_max: 5,
      evidence: ["four to five days in the office"],
    });
  });

  it.each([
    "You will spend two days in the office.",
    "You will spend three days in the office.",
    "Up to two days in the office.",
    "Up to three days a week in the office.",
    "We meet four days a month in the office.",
    "We meet four days per month in the office.",
    "We meet four days in the office per month.",
    "We meet four days in the office, each quarter.",
    "We meet five days on-site every quarter.",
    "Each month, four days in the office are planned.",
    "You spend two of the five days in the office.",
    "Four days remote and the rest flexible.",
    "We offer a four-day work week.",
    "You get five days of annual leave.",
    "We reply within five working days.",
    "Onboarding takes four days of office orientation.",
    "The audit closes twenty-four days after the office review.",
  ])("does not reject: %s", (sentence) => {
    expect(officeReject(gate(sentence)), sentence).toBe(false);
    expect(readOfficeDayWords(sentence.toLowerCase()), sentence).toBe(sentence.toLowerCase());
  });

  it("reads 'four office days' on a hybrid posting, as it reads '4 office days'", () => {
    expect(officeReject(gate("There are four office days each week."))).toBe(true);
    expect(gate("There are four office days each week.", "UNKNOWN").status)
      .toBe(gate("There are 4 office days each week.", "UNKNOWN").status);
  });

  it("judges a persisted office-days requirement whose quote spells the count", () => {
    const requirement = (quote: string) => [{
      requirement_key: "office", requirement_type: "OFFICE_DAYS", importance: "MUST",
      requirement_text: quote, quote_text: quote, structured_value: {},
    }];
    const job = { title: "Senior Data Engineer", company_name: "Acme Analytics", description: DUTIES };
    expect(applyPersistedRequirementGates(job, requirement("four days in the office"), policy).rejection_codes)
      .toContain("GATE_HIGH_OFFICE_DAYS");
    expect(applyPersistedRequirementGates(job, requirement("two days in the office"), policy).status).toBe("PASS");
  });

  it("rewrites to the same length, so match offsets quote the original", () => {
    const text = "four (4) days in the office, three to five days on-site";
    const read = readOfficeDayWords(text);
    expect(read).toHaveLength(text.length);
    expect(read).toBe("4        days in the office, 3     to 5    days on-site");
  });

  it("stays fast on long untrusted text", () => {
    const hostile = [
      "four ".repeat(20_000),
      "four to ".repeat(20_000),
      "four (4) ".repeat(10_000),
      `four${" ".repeat(100_000)}days in the office`,
      `four days${" ".repeat(100_000)}in the office`,
      `four days in the office${" ".repeat(100_000)}x`,
      "four days in the office per ".repeat(5_000),
      `${"of ".repeat(30_000)}four days in the office`,
    ];
    const started = performance.now();
    for (const text of hostile) readOfficeDayWords(text);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("office-first order (owner decision 2026-11-26)", () => {
  const REJECTS = [
    "Our crew sits in the office four days a week.",
    "Our crew sits in the office 4 days a week.",
    "Staff are in our office four days per week.",
    "You will be in the Harbour Road office for at least four days each week.",
    "Please work from office 5 days a week.",
    "Please work from the office five days a week.",
    "This is a work-from-office, 5 days weekly arrangement. Work from office five days weekly.",
    "On-site four days a week.",
    "You are on-site four days a week.",
    "This role is on-site 4 days a week.",
    "Onsite 4 days/week.",
    "In-office: 4 days per week.",
    "In-office 5 days a week.",
    "Staff come to our office four to five days a week.",
    "We're in the office two to four days a week.",
    "Be in the office, minimum 4 days a week.",
    "Attendance at our office four (4) days a week is expected.",
    "You are expected in the office 4+ days a week.",
    "Everyone is in the office 4 out of 5 days a week.",
    "The role is office-based five days a week.",
    "Be in the office up to four days a week.",
    "<li>In the office five days a week</li>",
  ];

  it.each(REJECTS)("rejects: %s", (sentence) => {
    for (const workplaceType of ["HYBRID", "UNKNOWN", "ASSUMED_HYBRID"]) {
      expect(officeReject(gate(sentence, workplaceType)), `${workplaceType}: ${sentence}`).toBe(true);
    }
  });

  it.each([
    "Staff are in the office two days a week.",
    "Staff are in the office 3 days a week.",
    "Staff are in the office up to three days a week.",
    "Staff are in the office up to 2 days per week.",
    "Staff are in the office three out of five days a week.",
    "Staff are in the office four days a month.",
    "Staff are in the office 4 days per month.",
    "Staff are in the office five days each quarter.",
    "Staff are in the office four days.",
    "Staff are in the office five days a week during your first month.",
    "Staff are in the office five days a week for one week each quarter.",
    "Staff are in the office five days a week once a quarter.",
    "You are not expected in the office five days a week.",
    "You don't need to be in the office five days a week.",
    "Instead of being in the office five days a week, we meet when it helps.",
    "You may work in the office five days a week if you prefer.",
    "Being in the office five days a week is optional.",
    "Free lunch is served in the office five days a week.",
    "A physiotherapist is on-site four days a week.",
    "Our crew works on-site four days a week.",
    "We support surveyors who are on-site five days a week.",
    "All staff are in-office 5 days a week.",
    "Our help desk answers calls from the office within five working days.",
    "We offer on-site training four days a year.",
    "The kiosk in our office lobby opens five days a week.",
    "In the office we run a four-day work week.",
    "Staff in the office receive five days of annual leave per year.",
  ])("does not reject: %s", (sentence) => {
    expect(officeReject(gate(sentence)), sentence).toBe(false);
  });

  it.each([
    "In the office 4-5 days a week.",
    "You are in the office 4-5 days per week.",
    "Work from office 4-5 days a week.",
    "On-site 4-5 days per week.",
    // A range whose top reaches four rejects, as "3-4 days in the office" does.
    "In the office 3-4 days a week.",
    "Our crew sits in the office three-four days a week.",
    "We want everyone to be in the office 4 days a week.",
    "You need to be in the office four days a week.",
    "The post requires you to be in the office four days per week.",
    "You will need to come into the office four days a week.",
    "Willingness to work from the office five days a week.",
    "From your first day, you will be in the office five days a week.",
    "During the week you are in the office five days a week.",
    "In your first-rate team you are in the office five days a week.",
    "You are in the office five days a week. Questions? Ask us.",
  ])("rejects range, infinitive and standing statements: %s", (sentence) => {
    for (const workplaceType of ["HYBRID", "UNKNOWN", "ASSUMED_HYBRID"]) {
      expect(officeReject(gate(sentence, workplaceType)), `${workplaceType}: ${sentence}`).toBe(true);
    }
  });

  it.each([
    "For the first three months, you will be in the office five days a week.",
    "During probation, you will be in the office 5 days a week.",
    "In your first two weeks, be in the office five days a week.",
    "In your first month, you will be in the office five days a week. After that, two days.",
    "During onboarding you will be in the office five days a week, then two days a week.",
    "You will be in the office five days a week for the first 90 days.",
    "You will be in the office five days a week for your first 90 days. Afterwards, hybrid with two days.",
    "You will be in the office five days a week initially, moving to two days.",
    "During the first 90 days you are in the office five days a week.",
    "Initially, you will be in the office five days a week.",
    "During your 3-month probation, you will be in the office five days a week.",
    "You will be in the office five days a week for the first eight weeks.",
    "Gone are the days of being in the office five days a week.",
    "Tired of being in the office five days a week?",
    "In the office 5 days a week? Not here.",
    "In the office 2-3 days a week.",
    "On-site 2-3 days per week.",
    "Work from office 4-5 days a month.",
    "In the office 4-5 days per quarter.",
    "You need to be in the office up to three days a week.",
    "You will not need to be in the office four days a week.",
  ])("does not reject temporary, dismissed, asked or lower statements: %s", (sentence) => {
    for (const workplaceType of ["HYBRID", "UNKNOWN", "ASSUMED_HYBRID"]) {
      expect(officeReject(gate(sentence, workplaceType)), `${workplaceType}: ${sentence}`).toBe(false);
    }
  });

  it("stores a hyphen range after the office", () => {
    expect(findOfficeFirstDays("in the office 4-5 days a week.")).toMatchObject({ min: 4, max: 5 });
    expect(findOfficeFirstDays("in the office five-day rota a week.")).toBeNull();
  });

  it("quotes the statement and stores the stated range", () => {
    const result = gate("Our crew sits in the office four to five days a week.");
    expect(result.rejection_codes).toEqual(["GATE_HIGH_OFFICE_DAYS"]);
    expect(result.evidence_quotes).toEqual(["in the office four to five days a week"]);
    expect(result.workability_facts).toMatchObject({ office_days_min: 4, office_days_max: 5 });
  });

  it("takes the highest weekly statement", () => {
    expect(findOfficeFirstDays("staff are in the office two days a week. leads are in the office five days a week."))
      .toMatchObject({ min: 5, max: 5 });
  });

  it("uses the policy thresholds", () => {
    const wider = { ...policy, maxOfficeDaysPerWeek: 4, hardFailOfficeDaysPerWeek: 5 };
    const narrower = { ...policy, maxOfficeDaysPerWeek: 2 };
    expect(officeReject(gate("Staff are in the office four days a week.", "HYBRID", wider))).toBe(false);
    expect(officeReject(gate("Staff are in the office three days a week.", "HYBRID", narrower))).toBe(true);
  });

  it("stays fast on long untrusted text", () => {
    const hostile = [
      "in the office ".repeat(10_000),
      "in the office four ".repeat(8_000),
      "in the office four days ".repeat(6_000),
      `in the office${" ".repeat(100_000)}four days a week`,
      `in the office four days${" ".repeat(100_000)}a week`,
      "at our big old office four to five days a week ".repeat(3_000),
      `on-site ${"(".repeat(50_000)}`,
      "office ".repeat(20_000),
      "during the first in the office four days a week ".repeat(3_000),
      "in your first 90 in the office 4-5 days a week for the first ".repeat(2_000),
      `in the office four days a week${" ".repeat(100_000)}?`,
      `in the office ${"4-".repeat(50_000)}`,
    ];
    const started = performance.now();
    for (const text of hostile) findOfficeFirstDays(text);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
