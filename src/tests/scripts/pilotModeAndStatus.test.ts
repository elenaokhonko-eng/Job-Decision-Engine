import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { isWorkflowKillSwitchOn } from "../../../scripts/report_pipeline_status.js";

describe("pipeline pilot mode safeguards", () => {
  it("treats only a true kill-switch value as globally off", () => {
    expect(isWorkflowKillSwitchOn("true")).toBe(true);
    expect(isWorkflowKillSwitchOn(" TRUE ")).toBe(true);
    expect(isWorkflowKillSwitchOn("false")).toBe(false);
    expect(isWorkflowKillSwitchOn(undefined)).toBe(false);
  });

  it("prints the kill-switch warning before attempting status database access", () => {
    const source = readFileSync(resolve("scripts/report_pipeline_status.ts"), "utf8");
    expect(source.indexOf("WORKFLOW_KILL_SWITCH IS ON")).toBeGreaterThan(-1);
    expect(source.indexOf("WORKFLOW_KILL_SWITCH IS ON")).toBeLessThan(source.indexOf("DATABASE_URL is required"));
    expect(source).toContain("workflow_kill_switch_on: workflowKillSwitchOn");
  });

  it("maps the retest gate command to its implementation", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["e2e:retest-gate"]).toBe("tsx scripts/check_e2e_retest_gate.ts");
  });
});
