import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

type Setting = { version: string; minScore: number | null };

/** Load the real modules against one floor value (the suite-wide fixture is replaced per call). */
async function withFloor(minScore: number | null) {
  vi.resetModules();
  vi.doMock("../../pipeline/reviewFitFloorSetting.js", () => ({
    REVIEW_FIT_FLOOR_SETTING: { version: "review_fit_floor_v1", minScore },
  }));
  return {
    floor: await import("../../pipeline/reviewFitFloor.js"),
    policy: await import("../../policy/decisionPolicy.js"),
    matcher: await import("../../pipeline/deterministicMatcher.js"),
    version: await import("../../pipeline/deciderVersion.js"),
  };
}

afterEach(() => {
  vi.doUnmock("../../pipeline/reviewFitFloorSetting.js");
  vi.resetModules();
});

const inputs = { gate_decision: "PASS", requirement_score: 0.55, coverage_score: 0.1, evidence_completeness: 0.1 };

describe("Review fit floor", () => {
  it("ships unset: no value is approved", async () => {
    const shipped = await vi.importActual<{ REVIEW_FIT_FLOOR_SETTING: Setting }>("../../pipeline/reviewFitFloorSetting.js");
    // When the owner approves a value, change minScore AND version together and update this expectation.
    expect(shipped.REVIEW_FIT_FLOOR_SETTING).toEqual({ version: "review_fit_floor_v1", minScore: null });
  });

  it("throws while unset, and never applies the legacy 0.5 threshold instead", async () => {
    const { floor, policy } = await withFloor(null);
    expect(() => floor.requireReviewFitFloor()).toThrow(floor.ReviewFitFloorUnsetError);
    expect(() => policy.applyReviewFitFloor(policy.DEFAULT_DECISION_POLICY)).toThrow(/REVIEW_FIT_FLOOR_UNSET/);
  });

  it("stops the matcher before it touches the database while unset", async () => {
    const { matcher } = await withFloor(null);
    const query = vi.fn();
    const client = { query, release: vi.fn() } as unknown as pg.PoolClient;
    await expect(matcher.runDeterministicMatcher(client)).rejects.toThrow(/REVIEW_FIT_FLOOR_UNSET/);
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses a fraction-form or out-of-range value", async () => {
    for (const value of [0.5, 1, 0, -3, 101, Number.NaN]) {
      const { floor } = await withFloor(value);
      expect(() => floor.requireReviewFitFloor()).toThrow(/REVIEW_FIT_FLOOR_UNSET/);
    }
  });

  it("carries the approved floor into the Review rule only, as a fraction of the 0..100 score", async () => {
    // 60 is a test input, not a proposed floor.
    const { policy } = await withFloor(60);
    const applied = policy.applyReviewFitFloor(policy.DEFAULT_DECISION_POLICY);
    expect(policy.evaluateDecisionPolicy(applied, inputs).outcome).toBe("TRACK");
    expect(policy.evaluateDecisionPolicy(applied, { ...inputs, requirement_score: 0.6 }).outcome).toBe("REVIEW");
    const others = (rules: typeof applied.outcome_rules) => rules.filter((rule) => rule.id !== policy.REVIEW_FLOOR_RULE_ID);
    expect(others(applied.outcome_rules)).toEqual(others(policy.DEFAULT_DECISION_POLICY.outcome_rules));
    expect(policy.hashDecisionPolicy(applied)).not.toBe(policy.hashDecisionPolicy(policy.DEFAULT_DECISION_POLICY));
  });

  it("fails loudly for a policy with no rule to carry the floor", async () => {
    const { policy } = await withFloor(60);
    const withoutRule = {
      ...policy.DEFAULT_DECISION_POLICY,
      outcome_rules: policy.DEFAULT_DECISION_POLICY.outcome_rules.filter((rule) => rule.id !== policy.REVIEW_FLOOR_RULE_ID),
    };
    expect(() => policy.applyReviewFitFloor(withoutRule)).toThrow(/exactly one/);
  });

  it("is part of the decider version, so a new floor version re-decides", async () => {
    const { version } = await withFloor(60);
    expect(version.DECIDER_VERSION).toBe("recommendation_decider_v3+review_fit_floor_v1");
  });
});
