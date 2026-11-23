import { describe, expect, it } from "vitest";

import {
  ROLE_SHAPE_MAX_TOTAL_PENALTY,
  applyRoleShapePenalty,
  assessRoleShape,
  roleShapeFingerprint,
} from "../../pipeline/roleShape.js";

// Synthetic titles and sentences only.
describe("role shape: customer-facing delivery", () => {
  it.each([
    "Solutions Engineer, Applied AI",
    "Forward Deployed Engineer",
    "Customer Success Manager, Data Products",
    "Implementation Consultant",
  ])("flags the title %s", (title) => {
    const result = assessRoleShape({ title, description: "Build things." });
    expect(result.signals.map((s) => s.code)).toEqual(["CUSTOMER_FACING_DELIVERY"]);
    expect(result.signals[0]!.source).toBe("TITLE");
    expect(result.total_penalty).toBeGreaterThan(0);
  });

  it("flags a description with two separate cues, and quotes the words", () => {
    const description = "You will be customer-facing from day one. Most of the work is client implementations and post-sales support.";
    const result = assessRoleShape({ title: "Data Platform Lead", description });
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.source).toBe("DESCRIPTION");
    expect(description.replace(/\s+/g, " ")).toContain(result.signals[0]!.quote);
  });

  it("does not flag a single passing mention", () => {
    const result = assessRoleShape({ title: "Machine Learning Engineer", description: "You may join the occasional customer-facing demo." });
    expect(result.signals).toEqual([]);
    expect(result.total_penalty).toBe(0);
  });
});

describe("role shape: penalty is a downrank, never a rejection", () => {
  it("lowers the score by the penalty share and keeps a null score null", () => {
    const assessment = assessRoleShape({ title: "Forward Deployed Engineer", description: "" });
    expect(applyRoleShapePenalty(0.7, assessment)).toBeCloseTo(0.7 * (1 - assessment.total_penalty), 3);
    expect(applyRoleShapePenalty(0.7, assessment)).toBeGreaterThan(0);
    expect(applyRoleShapePenalty(null, assessment)).toBeNull();
    expect(applyRoleShapePenalty(0.7, assessShapeNone())).toBe(0.7);
  });

  it("never removes more than the cap", () => {
    expect(ROLE_SHAPE_MAX_TOTAL_PENALTY).toBeLessThanOrEqual(0.2);
  });

  it("is deterministic and fingerprints the assessment", () => {
    const input = { title: "Customer Success Manager", description: "x" };
    expect(roleShapeFingerprint(assessRoleShape(input))).toBe(roleShapeFingerprint(assessRoleShape(input)));
    expect(roleShapeFingerprint(assessRoleShape(input))).not.toBe(roleShapeFingerprint(assessShapeNone()));
  });
});

function assessShapeNone() {
  return assessRoleShape({ title: "Data Scientist", description: "Model things." });
}
