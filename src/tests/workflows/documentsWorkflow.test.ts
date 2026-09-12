import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("documents workflow", () => {
  it("skips auto-pick cleanly when no document-ready job exists", () => {
    const workflow = readFileSync(resolve(".github/workflows/documents.yml"), "utf8");
    const picker = readFileSync(resolve("scripts/pick_documents_job.ts"), "utf8");

    expect(workflow).toContain('PICK_DOCUMENTS_ALLOW_EMPTY: "true"');
    expect(workflow).toContain("DOCUMENTS_JOB_FOUND=false");
    expect(workflow).toContain("DOCUMENTS_JOB_FOUND=true");
    expect(workflow).toContain("No eligible jobs found for document generation yet. Generation was skipped.");
    expect(workflow).toContain("if: env.DOCUMENTS_JOB_FOUND == 'true'");
    expect(workflow).toContain("always() && env.DOCUMENTS_JOB_FOUND == 'true'");
    expect(workflow).toContain("npx tsx scripts/preflight_database.ts");
    expect(workflow).toContain("INPUT_CANONICAL_JOB_ID: ${{ inputs.canonical_job_id }}");
    expect(workflow).toContain("canonical_job_id must be a UUID.");
    expect(workflow).toContain("job_version_id must be a UUID when provided.");

    expect(picker).toContain("PICK_DOCUMENTS_ALLOW_EMPTY");
    expect(picker).toContain("documents_job_found: false");
    expect(picker).toContain("documents_job_found: true");
    expect(picker).toContain("process.exitCode = allowEmptyAutoPick ? 0 : 1");

    const jobVersionJoin = picker.indexOf("JOIN job_versions jv");
    const matchRunJoin = picker.indexOf("JOIN match_runs mr");
    expect(jobVersionJoin).toBeGreaterThan(-1);
    expect(matchRunJoin).toBeGreaterThan(jobVersionJoin);
  });
});
