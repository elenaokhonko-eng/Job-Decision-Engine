import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("discovery ingestion workflow", () => {
  it("does not run a completed pipeline after either required source stage fails", () => {
    const workflow = readFileSync(resolve(".github/workflows/ingest.yml"), "utf8");

    expect(workflow).toContain(
      "needs.gmail_ingestion.result == 'success' && needs.public_source_ingestion.result == 'success'"
    );
    expect(workflow).not.toContain(
      "needs.gmail_ingestion.result == 'success' || needs.public_source_ingestion.result == 'success'"
    );
  });
});
