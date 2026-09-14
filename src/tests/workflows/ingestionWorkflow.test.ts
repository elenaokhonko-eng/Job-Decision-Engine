import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("discovery ingestion workflow", () => {
  it("drains available pipeline work when discovery runs and surfaces upstream source failures", () => {
    const workflow = readFileSync(resolve(".github/workflows/ingest.yml"), "utf8");

    expect(workflow).toContain("needs: [gmail_ingestion, public_source_ingestion]");
    expect(workflow).toContain("needs.gmail_ingestion.result == 'success' || needs.public_source_ingestion.result == 'success'");
    expect(workflow).toContain("Check ingestion completeness");
    expect(workflow).toContain("needs.gmail_ingestion.result != 'success' || needs.public_source_ingestion.result != 'success'");
  });
});
