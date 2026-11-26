import { describe, expect, it } from "vitest";

import { claimableTaskTypes, withoutHeldQueueRows } from "../../modules/evaluation/index.js";
import { assertAiWorkSettingsValid, readAiWorkSettings } from "../../platform/config/index.js";

const env = (enabled?: string, cutoff?: string, policy?: string): NodeJS.ProcessEnv => ({
  ...(enabled === undefined ? {} : { AI_EVALUATION_ENABLED: enabled }),
  ...(cutoff === undefined ? {} : { AI_EVALUATION_SCORE_CUTOFF: cutoff }),
  ...(policy === undefined ? {} : { AI_EVALUATION_SCORE_POLICY: policy }),
});
const POLICY = "deterministic_v3|role_shape_v2";

describe("owner AI switch", () => {
  it.each([
    ["nothing configured", env(), "AI_EVALUATION_NOT_ENABLED"],
    ["empty values", env("", "  ", ""), "AI_EVALUATION_NOT_ENABLED"],
    ["a cut-off without the switch", env(undefined, "0.7", POLICY), "AI_EVALUATION_NOT_ENABLED"],
    ["the switch off", env("false", "0.7", POLICY), "AI_EVALUATION_NOT_ENABLED"],
    ["the switch without a cut-off", env("true", undefined, POLICY), "AI_SCORE_CUTOFF_NOT_APPROVED"],
    ["a cut-off without its score policy", env("true", "0.7"), "AI_SCORE_POLICY_NOT_APPROVED"],
  ])("stays closed, without error, with %s", (_name, values, reason) => {
    const settings = readAiWorkSettings(values);
    expect(settings).toEqual({ mode: "HELD", reason });
    expect(() => assertAiWorkSettingsValid(settings)).not.toThrow();
  });

  it.each([
    ["a switch value other than true or false", env("TRUE", "0.7", POLICY), "AI_EVALUATION_ENABLED_INVALID"],
    ["a cut-off on the percent scale", env("true", "70", POLICY), "AI_SCORE_CUTOFF_INVALID"],
    ["a cut-off of 1", env("true", "1", POLICY), "AI_SCORE_CUTOFF_INVALID"],
    ["a negative cut-off", env("true", "-0.1", POLICY), "AI_SCORE_CUTOFF_INVALID"],
    ["a cut-off that is not a number, switch off", env("false", "high"), "AI_SCORE_CUTOFF_INVALID"],
    ["a score policy of another form", env("true", "0.7", "role_shape_v2"), "AI_SCORE_POLICY_INVALID"],
  ])("holds and fails the run with %s", (_name, values, reason) => {
    const settings = readAiWorkSettings(values);
    expect(settings).toEqual({ mode: "HELD", reason });
    expect(() => assertAiWorkSettingsValid(settings)).toThrow(reason);
  });

  it("opens only with all three settings", () => {
    expect(readAiWorkSettings(env("true", "0.65", POLICY)))
      .toEqual({ mode: "OPEN", scoreCutoff: 0.65, scorePolicy: POLICY });
    expect(readAiWorkSettings(env("true", "0.65", "deterministic_v3+topk_capability_semantic_v1|role_shape_v2")).mode)
      .toBe("OPEN");
  });

  it("leaves held tasks unclaimed and out of the backlog SLOs, and nothing else", () => {
    const held = readAiWorkSettings(env());
    const open = readAiWorkSettings(env("true", "0.5", POLICY));
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
