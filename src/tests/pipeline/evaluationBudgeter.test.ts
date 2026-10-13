import { describe, expect, it } from "vitest";
import { selectEvaluationBudget } from "../../pipeline/evaluationBudgeter.js";

function candidate(id: string, lane: string, priorityScore: number, wasDeferredByBudget = false) {
  return {
    id,
    lane,
    priorityScore,
    createdAt: "2026-01-01T00:00:00.000Z",
    wasDeferredByBudget,
  };
}

describe("evaluation budget selection", () => {
  it("reserves capacity per lane before applying a fair total limit", () => {
    const result = selectEvaluationBudget(
      [
        candidate("core-1", "CORE_AI_DATA", 0.9),
        candidate("core-2", "CORE_AI_DATA", 0.8),
        candidate("legal-1", "LEGAL_REGTECH", 0.7),
        candidate("legal-2", "LEGAL_REGTECH", 0.6),
      ],
      { CORE_AI_DATA: 2, LEGAL_REGTECH: 2 },
      3,
    );

    expect(result.selected.map((item) => item.id)).toEqual(["core-1", "legal-1", "core-2"]);
    expect(result.deferred.map((item) => item.id)).toEqual(["legal-2"]);
  });

  it("prioritizes previously deferred jobs without exceeding the lane budget", () => {
    const result = selectEvaluationBudget(
      [
        candidate("new", "CORE_AI_DATA", 1),
        candidate("deferred", "CORE_AI_DATA", 0.1, true),
      ],
      { CORE_AI_DATA: 1 },
    );

    expect(result.selected.map((item) => item.id)).toEqual(["deferred"]);
    expect(result.deferred.map((item) => item.id)).toEqual(["new"]);
  });

  it("defers lanes without configured capacity instead of rejecting them", () => {
    const result = selectEvaluationBudget(
      [candidate("unknown-lane", "UNCLASSIFIED", 0.5)],
      { CORE_AI_DATA: 3 },
    );

    expect(result.selected).toEqual([]);
    expect(result.deferred.map((item) => item.id)).toEqual(["unknown-lane"]);
  });
});
