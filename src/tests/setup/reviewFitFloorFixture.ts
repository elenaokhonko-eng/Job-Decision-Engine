import { vi } from "vitest";

/**
 * TEST FIXTURE ONLY, not a proposed or approved floor. The shipped setting is deliberately unset (and
 * reviewFitFloor.test.ts proves that it throws); every other test needs some value to run the matcher and decider.
 * 50 keeps the outcomes the existing deterministic fixtures were written for.
 */
vi.mock("../../pipeline/reviewFitFloorSetting.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../pipeline/reviewFitFloorSetting.js")>();
  return { REVIEW_FIT_FLOOR_SETTING: { ...original.REVIEW_FIT_FLOOR_SETTING, minScore: 50 } };
});
