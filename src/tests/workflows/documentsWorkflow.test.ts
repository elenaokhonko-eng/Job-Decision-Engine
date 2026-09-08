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

    expect(picker).toContain("PICK_DOCUMENTS_ALLOW_EMPTY");
    expect(picker).toContain("documents_job_found: false");
    expect(picker).toContain("documents_job_found: true");
    expect(picker).toContain("process.exitCode = allowEmptyAutoPick ? 0 : 1");
  });
});
