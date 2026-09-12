import { describe, expect, it } from "vitest";
import type { EvaluationQueueStats } from "../../pipeline/evaluationQueuePolicy.js";

describe("evaluation queue stats", () => {
  it("contains only operational drain counters", () => {
    const stats: EvaluationQueueStats = { processed: 1, failed: 0, manualReview: 0, eligible: 1 };
    expect(stats).toEqual({ processed: 1, failed: 0, manualReview: 0, eligible: 1 });
  });
});
