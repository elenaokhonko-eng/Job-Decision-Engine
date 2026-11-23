import { describe, expect, it } from "vitest";
import { checkPrimaryAnswered, PrimaryNotServedError } from "../../../platform/llm/index.js";
import { answeredByOtherModelCount, failedRunCount, failedRun, toModelRun } from "../../../../scripts/compare_evaluation_models.js";

describe("measurement run: the requested model must answer", () => {
  it("passes when the requested model answered without fallback", () => {
    expect(checkPrimaryAnswered({ expectedModel: "model-a", servedModel: "model-a", fallbackUsed: false })).toBeNull();
  });

  it("fails when another model answered", () => {
    const error = checkPrimaryAnswered({ expectedModel: "model-a", servedModel: "model-b" });
    expect(error).toBeInstanceOf(PrimaryNotServedError);
    expect(error?.code).toBe("PRIMARY_NOT_SERVED");
  });

  it("fails when the gateway reports a fallback even if the model name matches", () => {
    expect(checkPrimaryAnswered({ expectedModel: "model-a", servedModel: "model-a", fallbackUsed: true })).not.toBeNull();
  });

  it("marks a comparison run answered by another model as failed, and the run count drives a non-zero exit", () => {
    const base = { evaluatedJob: { next_action: "APPLY", primary_lane: null }, usage: null };
    const ok = toModelRun({ ...base, model: "model-a" }, "model-a");
    const other = toModelRun({ ...base, model: "model-b" }, "model-a");
    expect(ok.ok).toBe(true);
    expect(other.ok).toBe(false);
    expect(other.failureKind).toBe("ANSWERED_BY_OTHER_MODEL");
    expect(answeredByOtherModelCount({ models: [{ answered_by_other_model: 0 }] })).toBe(0);
    expect(answeredByOtherModelCount({ models: [{ answered_by_other_model: 1 }, { answered_by_other_model: 2 }] })).toBe(3);
  });

  it("treats a fallback that returns the same model name as not answered by the requested model", () => {
    const run = toModelRun({ evaluatedJob: {}, usage: null, model: "model-a", fallbackUsed: true }, "model-a");
    expect(run.ok).toBe(false);
    expect(run.failureKind).toBe("ANSWERED_BY_OTHER_MODEL");
  });

  it("counts thrown-error runs as failures so the run exits non-zero", () => {
    expect(failedRun(new Error("boom")).ok).toBe(false);
    expect(failedRunCount({ models: [{ failed: 0 }] })).toBe(0);
    expect(failedRunCount({ models: [{ failed: 1 }, { failed: 2 }] })).toBe(3);
  });
});
