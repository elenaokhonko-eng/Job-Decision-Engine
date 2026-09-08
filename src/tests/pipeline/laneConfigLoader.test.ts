import { describe, expect, it } from "vitest";
import { loadGlobalLanesConfig } from "../../pipeline/laneConfigLoader.js";

describe("lane configuration thresholds", () => {
  it("uses routing minimum semantic scores for primary routing", () => {
    const config = loadGlobalLanesConfig();

    expect(config.lanes.CORE_AI_DATA.semantic_threshold).toBe(0.35);
    expect(config.lanes.CORE_AI_DATA.threshold).toBe(0.35);
    expect(config.lanes.LEGAL_REGTECH.semantic_threshold).toBe(0.4);
    expect(config.lanes.CORE_AI_DATA.minimum_domain_score).toBe(0.6);
    expect(config.lanes.CORE_AI_DATA.minimum_function_score).toBe(0.6);
  });

  it("keeps data science as a Core AI/Data function concept", () => {
    const config = loadGlobalLanesConfig();

    expect(config.lanes.CORE_AI_DATA.required_function_concepts).toContain("data science");
  });
});
