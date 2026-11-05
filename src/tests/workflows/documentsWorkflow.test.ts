import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("public repository document workflow policy", () => {
  it("does not expose a GitHub Actions document generator or its dispatch validator", () => {
    expect(existsSync(resolve(".github/workflows/documents.yml"))).toBe(false);
    expect(existsSync(resolve("scripts/validate_document_workflow_dispatch.ts"))).toBe(false);
    expect(existsSync(resolve("src/services/documentWorkflowDispatchPolicy.ts"))).toBe(false);
  });

  it("documents local generation and keeps only real schedule claims in the sidebar", () => {
    const runbook = readFileSync(resolve("docs/release-runbook.md"), "utf8");
    const sidebar = readFileSync(resolve("streamlit_app.py"), "utf8");

    expect(runbook).toContain("Generate application documents locally");
    expect(runbook).not.toContain("Dispatch `documents.yml`");
    expect(sidebar).toContain("Daily ingestion");
    expect(sidebar).toContain("Hourly processing");
    expect(sidebar).not.toContain("Weekly LinkedIn Auto-Sync");
  });
});
