import { describe, expect, it } from "vitest";
import { shouldFailOnConsentMissing } from "../../pipeline/evaluationQueuePolicy.js";

describe("evaluation queue policy", () => {
  it("fails the drain when consent is missing and the workflow requires it", () => {
    expect(shouldFailOnConsentMissing("true")).toBe(true);
  });

  it("keeps non-drain callers from failing solely on an intentional consent opt-out", () => {
    expect(shouldFailOnConsentMissing(undefined)).toBe(false);
    expect(shouldFailOnConsentMissing("false")).toBe(false);
  });
});
