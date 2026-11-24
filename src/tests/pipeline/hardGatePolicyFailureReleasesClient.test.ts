import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../workspace/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../workspace/context.js")>()),
  resolveWorkspaceContext: vi.fn(async () => ({ workspaceId: "w", userId: "u", workspaceKey: "default", userKey: "default" })),
}));
vi.mock("../../policy/workspacePreferenceRegistry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../policy/workspacePreferenceRegistry.js")>()),
  resolveWorkspacePreferenceContext: vi.fn(async () => ({ stage3: {} })),
}));
// The real file loader is what throws when the policy file is missing.
vi.mock("../../pipeline/effectiveWorkabilityPolicy.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../pipeline/effectiveWorkabilityPolicy.js")>();
  const { loadWorkabilityPolicy } = await import("../../pipeline/workabilityPolicy.js");
  return {
    ...original,
    resolveEffectiveWorkabilityPolicy: vi.fn(async () => {
      loadWorkabilityPolicy();
      throw new Error("policy file unexpectedly present");
    }),
  };
});

import { resetConfigRootCache } from "../../config/configPaths.js";
import { runHardGates } from "../../pipeline/hardGate.js";

describe("runHardGates when the workability policy cannot be loaded", () => {
  const original = process.env.JDEC_CONFIG_DIR;
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jdec-gate-"));
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

  it("rejects, writes no gate decision, and gives the pooled client back", async () => {
    const queries: string[] = [];
    const release = vi.fn();
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(String(sql));
        return { rows: [] };
      }),
      release,
    };
    const pool = { connect: vi.fn(async () => client) };

    await expect(runHardGates(pool as never)).rejects.toThrow(/Workability policy not found/);

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(queries.some((sql) => /INSERT\s+INTO\s+gate_decisions/i.test(sql))).toBe(false);
  });
});
