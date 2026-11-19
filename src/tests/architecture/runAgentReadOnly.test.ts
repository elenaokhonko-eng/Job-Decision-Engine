import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// runAgent is the legacy free-form evaluator. Its output was once written straight into legacy job rows
// (scripts/evaluate_jobs.ts, removed). Nothing that calls it may write job rows again: the pipeline's
// own stages are the only writers of canonical_jobs, job_versions, jobs and raw_jobs.
const root = process.cwd();
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-backend", ".git", "tests"]);
const JOB_TABLE_WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:canonical_jobs|job_versions|jobs|raw_jobs|raw_job_observations)\b/i;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(?:ts|tsx|js|cjs|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("runAgent callers never write job rows", () => {
  const callers = [...sourceFiles(path.join(root, "src")), ...sourceFiles(path.join(root, "scripts"))].filter((file) => {
    if (file.endsWith(path.join("services", "agent.ts"))) return false; // the definition itself
    return /\brunAgent\s*\(/.test(fs.readFileSync(file, "utf8")) && /import[^;]*\brunAgent\b/.test(fs.readFileSync(file, "utf8"));
  });

  it("finds the known read-only callers (the check is not vacuous)", () => {
    const names = callers.map((file) => path.basename(file));
    expect(names).toEqual(expect.arrayContaining(["run_evals.ts", "test_agent.ts"]));
  });

  it.each(callers.map((file) => [path.relative(root, file).split(path.sep).join("/"), file]))("%s has no SQL write to a job table", (_name, file) => {
    expect(fs.readFileSync(file as string, "utf8")).not.toMatch(JOB_TABLE_WRITE);
  });

  it("the legacy evaluator script and its npm entry are gone", () => {
    expect(fs.existsSync(path.join(root, "scripts", "evaluate_jobs.ts"))).toBe(false);
    expect(fs.existsSync(path.join(root, "scripts", "re_evaluate_all.ts"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "package.json"), "utf8")).not.toMatch(/"eval:run"/);
  });
});
