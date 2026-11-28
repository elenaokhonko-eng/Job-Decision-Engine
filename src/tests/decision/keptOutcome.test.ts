import { describe, expect, it } from "vitest";

import { keepStoredOutcome, type KeptOutcomeFacts, type KeptResult } from "../../modules/decision/index.js";

const nothing: KeptOutcomeFacts = {
  gateDecision: "PASS", noMatchingLane: false, careerTrackCap: null, pay: null, readinessBlocked: false,
};
const priority: KeptResult = { eligibility: "ELIGIBLE", outcome: "PRIORITY" };
const keep = (facts: Partial<KeptOutcomeFacts>, stored: KeptResult = priority) => keepStoredOutcome(stored, { ...nothing, ...facts });

describe("the stored result of a job that waits for a re-match", () => {
  it("is unchanged when nothing real overrides it", () => {
    for (const outcome of ["PRIORITY", "REVIEW", "TRACK", "SKIP"] as const) {
      expect(keep({}, { eligibility: "ELIGIBLE", outcome })).toEqual({ eligibility: "ELIGIBLE", outcome, overrides: [] });
    }
  });

  it.each([
    ["a hard reject", { gateDecision: "HARD_REJECT" as const }, "INELIGIBLE", "SKIP"],
    ["a closed posting or other blocked readiness", { readinessBlocked: true }, "INELIGIBLE", "SKIP"],
    ["pay below the floor, rejected", { pay: "BELOW_FLOOR_REJECT" as const }, "INELIGIBLE", "SKIP"],
    // The rule alone. In the decider, pay below the floor also blocks readiness, so such a job ends at Skip.
    ["pay below the floor, held back, taken by itself", { pay: "BELOW_FLOOR_HOLD" as const }, "ELIGIBLE", "TRACK"],
    ["pay that needs verification", { pay: "UNVERIFIED" as const }, "ELIGIBLE", "REVIEW"],
    ["a fact that needs verification", { gateDecision: "NEEDS_VERIFICATION" as const }, "VERIFY", "REVIEW"],
    ["no matching lane", { noMatchingLane: true }, "ELIGIBLE", "SKIP"],
    ["the career-track cap at review", { careerTrackCap: "REVIEW" as const }, "ELIGIBLE", "REVIEW"],
    ["the career-track cap at skip", { careerTrackCap: "SKIP" as const }, "ELIGIBLE", "SKIP"],
  ])("is lowered by %s", (_label, facts, eligibility, outcome) => {
    const result = keep(facts);
    expect(result).toMatchObject({ eligibility, outcome });
    expect(result.overrides.length).toBeGreaterThan(0);
  });

  it("is never raised by any of those facts", () => {
    const ineligible: KeptResult = { eligibility: "INELIGIBLE", outcome: "SKIP" };
    const all: Partial<KeptOutcomeFacts>[] = [
      { gateDecision: "NEEDS_VERIFICATION" }, { pay: "UNVERIFIED" }, { pay: "BELOW_FLOOR_HOLD" }, { careerTrackCap: "REVIEW" },
    ];
    for (const facts of all) expect(keep(facts, ineligible)).toMatchObject({ eligibility: "INELIGIBLE", outcome: "SKIP" });
    expect(keep({ gateDecision: "NEEDS_VERIFICATION" }, { eligibility: "ELIGIBLE", outcome: "TRACK" })).toMatchObject({ outcome: "TRACK" });
    expect(keep({}, { eligibility: "VERIFY", outcome: "REVIEW" })).toMatchObject({ eligibility: "VERIFY", outcome: "REVIEW" });
  });
});
