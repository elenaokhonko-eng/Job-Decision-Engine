import { describe, expect, it } from "vitest";
import { isProfileFactModelShareable } from "../../profile/privacy.js";

describe("isProfileFactModelShareable", () => {
  it("never shares contact facts with model or embedding contexts", () => {
    expect(isProfileFactModelShareable({
      fact_type: "CONTACT",
      confidentiality: "PRIVATE_REUSABLE",
    })).toBe(false);
  });

  it("never shares private-internal facts regardless of fact type", () => {
    expect(isProfileFactModelShareable({
      fact_type: "SKILL",
      confidentiality: "PRIVATE_INTERNAL",
    })).toBe(false);
  });

  it("shares only explicitly public or reusable non-contact facts", () => {
    expect(isProfileFactModelShareable({
      fact_type: "SKILL",
      confidentiality: "PRIVATE_REUSABLE",
    })).toBe(true);
    expect(isProfileFactModelShareable({
      fact_type: "SKILL",
      confidentiality: "UNRECOGNIZED",
    })).toBe(false);
  });
});
