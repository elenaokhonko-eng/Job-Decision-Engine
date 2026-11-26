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

  // Not read in either spelling: the office comes before the count. Changing that would change digit behaviour.
  it.each(["come into the office four days per week", "come into the office 4 days per week"])(
    "leaves the office-first order unread: %s",
    (phrase) => {
      expect(officeReject(gate(`Our teams ${phrase}.`))).toBe(false);
    },
  );

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
