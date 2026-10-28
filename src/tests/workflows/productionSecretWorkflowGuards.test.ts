import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("production secret workflow guards", () => {
  it("restricts production database and API workflows to main", () => {
    for (const workflowPath of [
      ".github/workflows/ingest.yml",
      ".github/workflows/process_backlog.yml",
      ".github/workflows/managed_e2e_gate.yml",
      ".github/workflows/queue_worker.yml",
      ".github/workflows/documents.yml",
    ]) {
      const workflow = readFileSync(resolve(workflowPath), "utf8");
      expect(workflow, workflowPath).toContain("refs/heads/main");
    }
  });

  it("restricts desktop signing secrets to main or versioned release tags", () => {
    const workflow = readFileSync(resolve(".github/workflows/desktop-release.yml"), "utf8");

    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("startsWith(github.ref, 'refs/tags/v')");
  });
});
