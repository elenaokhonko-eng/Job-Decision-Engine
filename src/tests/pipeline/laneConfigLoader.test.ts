import { describe, expect, it } from "vitest";
import { loadGlobalLanesConfig } from "../../pipeline/laneConfigLoader.js";

describe("lane configuration thresholds", () => {
  it("uses the declared top-level semantic threshold for primary routing", () => {
    const config = loadGlobalLanesConfig();

    expect(config.lanes.CORE_AI_DATA.semantic_threshold).toBe(0.68);
    expect(config.lanes.CORE_AI_DATA.threshold).toBe(0.68);
    expect(config.lanes.CORE_AI_DATA.minimum_domain_score).toBe(0.6);
    expect(config.lanes.CORE_AI_DATA.minimum_function_score).toBe(0.6);
  });
});
