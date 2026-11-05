import { describe, expect, it } from "vitest";
import { withMaximumAiInterpretationsPerRun } from "../../lanes/evaluationBudgetConfig.js";

describe("lane evaluation budget configuration", () => {
  const lane = {
    schema_version: "2.2.0",
    lane_key: "CORE_AI_DATA",
    display_name: "Core AI & Data Engineering",
    description: "Technical AI and data roles.",
    budget: {
      maximum_ai_interpretations_per_run: 3,
      reserved_for_retries: 1,
    },
    routing: { minimum_semantic_score: 0.4 },
  };

  it("changes only the per-run AI interpretation cap", () => {
    expect(withMaximumAiInterpretationsPerRun(lane, 10)).toEqual({
      ...lane,
      budget: {
        ...lane.budget,
        maximum_ai_interpretations_per_run: 10,
      },
    });
    expect(lane.budget.maximum_ai_interpretations_per_run).toBe(3);
  });

  it.each([-1, 1.5, 1001, Number.NaN])("rejects invalid per-run cap %s", (maximum) => {
    expect(() => withMaximumAiInterpretationsPerRun(lane, maximum)).toThrow(/integer from 0 to 1000/);
  });
});
