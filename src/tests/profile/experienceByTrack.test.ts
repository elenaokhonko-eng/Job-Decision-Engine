import { describe, expect, it } from "vitest";

import { ProfileJsonSchema } from "../../profile/contracts.js";

const BASE = {
  profile_key: "synthetic_profile",
  profile_version: 1,
  display_name: "Synthetic Candidate",
  status: "ACTIVE",
};

describe("profile.json experience_by_track", () => {
  it("is optional, so existing profiles stay valid", () => {
    expect(ProfileJsonSchema.parse(BASE).experience_by_track).toBeUndefined();
  });

  it("accepts one entry per track with years and the candidate's own label", () => {
    const parsed = ProfileJsonSchema.parse({
      ...BASE,
      experience_by_track: [
        { track: "DATA_MANAGEMENT", years: 16, label: "Synthetic data management" },
        { track: "HANDS_ON_AI_DATA", years: 1.5, label: "Synthetic hands-on AI" },
      ],
    });
    expect(parsed.experience_by_track).toHaveLength(2);
  });

  it.each([
    [[{ track: "DATA_MANAGEMENT", years: 16 }], "missing label"],
    [[{ track: "AI_BRIDGE", years: 5, label: "x" }], "derived track"],
    [[{ track: "PRODUCT", years: -1, label: "x" }], "negative years"],
    [[{ track: "PRODUCT", years: 5, label: "x", seniority: "lead" }], "unknown key"],
    [[{ track: "PRODUCT", years: 5, label: "a" }, { track: "PRODUCT", years: 6, label: "b" }], "duplicate track"],
  ] as Array<[unknown[], string]>)("rejects %j (%s)", (entries, _reason) => {
    expect(() => ProfileJsonSchema.parse({ ...BASE, experience_by_track: entries })).toThrow();
  });
});
