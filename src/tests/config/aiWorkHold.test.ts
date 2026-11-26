import { describe, expect, it } from "vitest";

import { claimableTaskTypes, withoutHeldQueueRows } from "../../modules/evaluation/index.js";
import { readAiWorkSettings } from "../../platform/config/index.js";

const env = (enabled?: string, cutoff?: string): NodeJS.ProcessEnv => ({
  ...(enabled === undefined ? {} : { AI_EVALUATION_ENABLED: enabled }),
  ...(cutoff === undefined ? {} : { AI_EVALUATION_SCORE_CUTOFF: cutoff }),
});

describe("owner AI switch", () => {
  it.each([
    ["nothing configured", env(), "AI_EVALUATION_NOT_ENABLED"],
    ["a cut-off without the switch", env(undefined, "0.7"), "AI_EVALUATION_NOT_ENABLED"],
    ["a switch value other than exactly true", env("TRUE", "0.7"), "AI_EVALUATION_NOT_ENABLED"],
    ["the switch without a cut-off", env("true"), "AI_SCORE_CUTOFF_NOT_APPROVED"],
    ["the switch with a blank cut-off", env("true", "  "), "AI_SCORE_CUTOFF_NOT_APPROVED"],
    ["a cut-off on the percent scale", env("true", "70"), "AI_SCORE_CUTOFF_INVALID"],
    ["a cut-off of 1", env("true", "1"), "AI_SCORE_CUTOFF_INVALID"],
    ["a negative cut-off", env("true", "-0.1"), "AI_SCORE_CUTOFF_INVALID"],
    ["a cut-off that is not a number", env("true", "high"), "AI_SCORE_CUTOFF_INVALID"],
  ])("stays closed with %s", (_name, values, reason) => {
    expect(readAiWorkSettings(values)).toEqual({ mode: "HELD", reason });
  });

  it("opens only with both settings", () => {
    expect(readAiWorkSettings(env("true", "0.65"))).toEqual({ mode: "OPEN", scoreCutoff: 0.65 });
  });

  it("leaves held tasks unclaimed and out of the backlog SLOs, and nothing else", () => {
    const held = readAiWorkSettings(env());
    const open = readAiWorkSettings(env("true", "0.5"));
    const types = ["DECIDE_RECOMMENDATION", "ENQUEUE_EXPLANATION"];
    expect(claimableTaskTypes(types, held)).toEqual(["DECIDE_RECOMMENDATION"]);
    expect(claimableTaskTypes(types, open)).toEqual(types);

    const rows = ["PENDING", "RETRY_WAIT", "BLOCKED_DEPENDENCY", "DEAD_LETTER"]
      .map((status) => ({ task_type: "ENQUEUE_EXPLANATION", status }))
      .concat({ task_type: "DECIDE_RECOMMENDATION", status: "PENDING" });
    expect(withoutHeldQueueRows(rows, held).map((row) => `${row.task_type}:${row.status}`)).toEqual([
      "ENQUEUE_EXPLANATION:BLOCKED_DEPENDENCY",
      "ENQUEUE_EXPLANATION:DEAD_LETTER",
      "DECIDE_RECOMMENDATION:PENDING",
    ]);
    expect(withoutHeldQueueRows(rows, open)).toEqual(rows);
  });
});
