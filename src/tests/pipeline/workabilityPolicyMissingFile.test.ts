import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigRootCache } from "../../config/configPaths.js";
import { loadWorkabilityPolicy } from "../../pipeline/workabilityPolicy.js";

describe("loadWorkabilityPolicy with a missing policy file", () => {
  const original = process.env.JDEC_CONFIG_DIR;
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jdec-policy-"));
    fs.mkdirSync(path.join(tempRoot, "lanes"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "lanes", "registry.yml"), "lanes: []\n", "utf8");
    process.env.JDEC_CONFIG_DIR = tempRoot;
    resetConfigRootCache();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.JDEC_CONFIG_DIR; else process.env.JDEC_CONFIG_DIR = original;
    resetConfigRootCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("fails loudly instead of using built-in hard-gate defaults when lanes/registry.yml exists but policies/workability.yml does not", () => {
    expect(() => loadWorkabilityPolicy()).toThrow(/Workability policy not found/);
  });

  it("loads once the file is present", () => {
    fs.mkdirSync(path.join(tempRoot, "policies"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, "policies", "workability.yml"),
      "global_workability_gates:\n  work_mode:\n    max_office_days_hard_fail: 4\n",
      "utf8",
    );
    expect(loadWorkabilityPolicy().hardFailOfficeDaysPerWeek).toBe(4);
  });
});
