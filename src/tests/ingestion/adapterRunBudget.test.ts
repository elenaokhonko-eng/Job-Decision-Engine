import { describe, expect, it } from "vitest";

import { ADAPTER_RUN_BUDGET_DEFAULT_SECONDS, adapterRunBudgetMs, rotateDaily } from "../../../scripts/run_adapters.js";

describe("adapter run budget", () => {
  it("defaults to 30 minutes, inside the workflow step timeout", () => {
    expect(ADAPTER_RUN_BUDGET_DEFAULT_SECONDS).toBe(1_800);
    expect(adapterRunBudgetMs({})).toBe(1_800_000);
    expect(adapterRunBudgetMs({ ADAPTER_RUN_BUDGET_SECONDS: "  " })).toBe(1_800_000);
  });

  it("accepts whole seconds between 60 and 3600", () => {
    expect(adapterRunBudgetMs({ ADAPTER_RUN_BUDGET_SECONDS: "60" })).toBe(60_000);
    expect(adapterRunBudgetMs({ ADAPTER_RUN_BUDGET_SECONDS: "3600" })).toBe(3_600_000);
  });

  it("rejects malformed or out-of-range values instead of silently defaulting", () => {
    for (const value of ["59", "3601", "1.5", "-60", "30m", "abc"]) {
      expect(() => adapterRunBudgetMs({ ADAPTER_RUN_BUDGET_SECONDS: value })).toThrow(/ADAPTER_RUN_BUDGET_SECONDS/);
    }
  });

  it("rotates sources so a spent budget defers different ones on different days", () => {
    const sources = ["greenhouse", "lever", "ashby", "workable"];
    const day0 = rotateDaily(sources, new Date(0));
    const day1 = rotateDaily(sources, new Date(86_400_000));
    expect(day0.at(-1)).not.toBe(day1.at(-1));
    expect([...day1].sort()).toEqual([...sources].sort());
  });
});
