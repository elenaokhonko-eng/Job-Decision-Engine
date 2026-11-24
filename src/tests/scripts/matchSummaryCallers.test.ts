import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Scripts that call the matcher must not swallow a blocked or errored match (invariant 7): each one calls
// assertMatchSummaryComplete, no catch around that call may swallow the error, and the script ends non-zero on a throw.
const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

const SCRIPTS = [
  "scripts/stage1_capability_profile.ts",
  "scripts/rehearse_historical_recovery.ts",
  "scripts/rematch_current_actionable_profile.ts",
  "scripts/replay_policy_no_match.ts",
  "scripts/replay_requirement_extraction.ts",
  "scripts/reroute_all_gate_pass.ts",
];

describe("scripts that run the matcher fail on a blocked or errored match", () => {
  it.each(SCRIPTS)("%s asserts the match summary is complete", (file) => {
    expect(read(file)).toContain("assertMatchSummaryComplete(");
  });

  it.each(SCRIPTS)("%s ends non-zero when the top-level handler runs", (file) => {
    const source = read(file);
    expect(source).toMatch(/\.catch\([^)]*\)\s*=>\s*\{[\s\S]*?(process\.exit\(1\)|process\.exitCode\s*=\s*1)[\s\S]*?\}\);/);
  });

  it("stage1_capability_profile rethrows from the rematch catch (it used to log and exit 0)", () => {
    const source = read("scripts/stage1_capability_profile.ts");
    const catchBlock = source.slice(source.indexOf("Bounded rematch error"), source.indexOf("Stage 1 Capability Profile processing complete"));
    expect(catchBlock).toMatch(/throw error;/);
  });

  it.each(SCRIPTS)("%s has no catch that logs and continues around the assertion", (file) => {
    const source = read(file);
    let at = source.indexOf("assertMatchSummaryComplete(", source.indexOf("assertMatchSummaryComplete(") + 1);
    at = at === -1 ? source.indexOf("assertMatchSummaryComplete(") : source.indexOf("assertMatchSummaryComplete(");
    const afterAssert = source.slice(at);
    const nextCatch = afterAssert.search(/\}\s*catch\s*(\([^)]*\))?\s*\{/);
    if (nextCatch !== -1 && nextCatch < 400) {
      const catchBody = afterAssert.slice(nextCatch, nextCatch + 300);
      expect(catchBody).toMatch(/throw |exitCode\s*=\s*1|process\.exit\(1\)/);
    }
  });
});
